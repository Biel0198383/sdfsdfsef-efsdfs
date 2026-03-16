
const express = require("express")
const fs = require("fs")
const QRCode = require("qrcode")
const multer = require("multer")
const path = require("path")
const {
 default: makeWASocket,
 useMultiFileAuthState,
 fetchLatestBaileysVersion,
 DisconnectReason
} = require("@whiskeysockets/baileys")

const app = express()

app.use(express.urlencoded({extended:true}))
app.use(express.json())
app.use(express.static("public"))

const uploadDir = path.join(__dirname,"uploads")
if(!fs.existsSync(uploadDir)){
 fs.mkdirSync(uploadDir,{recursive:true})
}

app.use("/uploads", express.static(uploadDir))

const upload = multer({dest:uploadDir})

let sock
let conectado=false
let qrCode=null
let ultimoID=""
let grupos=[]
let fila=[]
let intervalo=15
let timer=null
let nextRunAt=null
let errorMsg=null
let paused=false
let intervaloRandom=false
let pausedReason=""
let pendingLimitWarning=null
let overrideLimitPeriod=null
let resumeAt=null
let resumeTimer=null

let contadorEnvios = {
 date: "",
 manha: 0,
 tarde: 0,
 noite: 0
}

const templates = {
 "1": `🔥 OFERTA IMPERDIVEL

📦 {nome}
📝 {descricao}

💸 De: {preco_antigo}
🔥 Por: {preco_novo}

🛒 Comprar:
{link}

⚡ Promocao por tempo limitado!`,
 "2": `🚨 PROMOCAO RELAMPAGO

📦 {nome}

💰 Apenas: {preco_novo}

🛍️ Garanta ja:
{link}`
}

async function iniciar(){

const {state,saveCreds} = await useMultiFileAuthState("auth")
const {version} = await fetchLatestBaileysVersion()

sock = makeWASocket({
 version,
 auth:state,
 browser:["BotOfertas","Chrome","1.0"]
})

sock.ev.on("creds.update",saveCreds)

sock.ev.on("connection.update",async(update)=>{

const {connection,lastDisconnect,qr} = update

if(qr){
 qrCode = await QRCode.toDataURL(qr)
}

if(connection==="open"){
 conectado=true
 qrCode=null
 console.log("WhatsApp conectado")
}

if(connection==="close"){
 conectado=false
 const statusCode = lastDisconnect?.error?.output?.statusCode
 if(statusCode===DisconnectReason.loggedOut){
  fs.rmSync("./auth",{recursive:true,force:true})
 }
 setTimeout(()=>iniciar(),4000)
}

})

sock.ev.on("messages.upsert",(m)=>{
 const msg=m.messages[0]
 if(!msg.key.fromMe){
  ultimoID = msg.key.remoteJid
  console.log("ID capturado:",ultimoID)
 }
})

}

iniciar()

function pararPostagem(){
 if(timer) clearTimeout(timer)
 timer = null
}

function cancelarRetomada(){
 if(resumeTimer) clearTimeout(resumeTimer)
 resumeTimer = null
}

function sleep(ms){
 return new Promise(r=>setTimeout(r,ms))
}

function randInt(min,max){
 return Math.floor(Math.random()*(max-min+1))+min
}

function proximoDelayMs(){
 if(intervaloRandom){
  return randInt(13,18) * 60000
 }
 return intervalo * 60000
}

function dataHoje(){
 const d = new Date()
 const y = d.getFullYear()
 const m = String(d.getMonth()+1).padStart(2,"0")
 const day = String(d.getDate()).padStart(2,"0")
 return `${y}-${m}-${day}`
}

function periodoAtual(){
 const h = new Date().getHours()
 if(h >= 6 && h < 12) return "manha"
 if(h >= 12 && h < 18) return "tarde"
 return "noite"
}

function limitePorPeriodo(periodo){
 if(periodo==="manha") return 10
 if(periodo==="tarde") return 10
 return 30
}

function resetarContadoresSeNovoDia(){
 const hoje = dataHoje()
 if(contadorEnvios.date !== hoje){
  contadorEnvios = {date:hoje, manha:0, tarde:0, noite:0}
  overrideLimitPeriod = null
 }
}

function inicioProximoPeriodo(){
 const now = new Date()
 const h = now.getHours()
 const next = new Date(now)
 if(h >= 6 && h < 12){
  next.setHours(12,0,0,0)
 }else if(h >= 12 && h < 18){
  next.setHours(18,0,0,0)
 }else{
  next.setDate(next.getDate()+1)
  next.setHours(6,0,0,0)
 }
 return next
}

function podeEnviarAgora(){
 resetarContadoresSeNovoDia()
 const periodo = periodoAtual()
 if(overrideLimitPeriod && overrideLimitPeriod !== periodo){
  overrideLimitPeriod = null
 }
 if(overrideLimitPeriod === periodo) return true
 const limite = limitePorPeriodo(periodo)
 if(contadorEnvios[periodo] >= limite){
  pendingLimitWarning = "O limite seguro de envios para este periodo foi atingido. Continuar enviando pode aumentar o risco de bloqueio."
  paused = true
  pausedReason = "limite"
  pararPostagem()
  agendarRetomada()
  return false
 }
 return true
}

function registrarEnvio(){
 resetarContadoresSeNovoDia()
 const periodo = periodoAtual()
 contadorEnvios[periodo] += 1
}

function agendarRetomada(){
 cancelarRetomada()
 if(pausedReason !== "limite") return
 const next = inicioProximoPeriodo()
 resumeAt = next.getTime()
 resumeTimer = setTimeout(()=>{
  if(pausedReason === "limite" && paused){
   paused = false
   pausedReason = ""
   pendingLimitWarning = null
   iniciarPostagem()
  }
 }, Math.max(0, resumeAt - Date.now()))
}

function aplicarTemplate(oferta){
 if(oferta.texto && !oferta.templateId) return oferta.texto
 const tpl = templates[oferta.templateId] || templates["1"]
 const data = {
  nome: oferta.nomeProduto || "-",
  descricao: oferta.descricao || "-",
  preco_antigo: oferta.precoAntigo || "-",
  preco_novo: oferta.precoNovo || "-",
  link: oferta.linkProduto || "-"
 }
 return tpl
  .replace("{nome}", data.nome)
  .replace("{descricao}", data.descricao)
  .replace("{preco_antigo}", data.preco_antigo)
  .replace("{preco_novo}", data.preco_novo)
  .replace("{link}", data.link)
}

async function enviarOferta(oferta){
 for(const g of grupos){
  try{
   if(paused) return
   const imagemParaEnvio = obterImagemParaEnvio(oferta)
   const texto = aplicarTemplate(oferta)
   await sock.sendPresenceUpdate("composing", g)
   await sleep(randInt(2000,3000))
   if(imagemParaEnvio){
    await sock.sendMessage(g,{
     image:{url:imagemParaEnvio},
     caption:texto
    })
   }else{
    await sock.sendMessage(g,{text:texto})
   }
   await sock.sendPresenceUpdate("paused", g)
   await sleep(randInt(4000,8000))
  }catch(e){console.log(e)}
 }
 console.log("Oferta enviada")
 registrarEnvio()
}

function iniciarPostagem(){
 pararPostagem()
 if(!conectado || fila.length===0 || paused) {
  nextRunAt = null
  return
 }
 const delayMs = proximoDelayMs()
 nextRunAt = Date.now() + delayMs
 timer = setTimeout(async()=>{
  if(!conectado || paused) return
  if(fila.length===0){
   nextRunAt = null
   return
  }
  const prox = obterProximaOferta()
  if(!prox){
   nextRunAt = null
   return
  }
  if(!podeEnviarAgora()){
   return
  }
  const oferta = fila.splice(prox.index,1)[0]
  await enviarOferta(oferta)
  iniciarPostagem()
 }, delayMs)
}

async function iniciarAgora(){
 pararPostagem()
 if(!conectado || fila.length===0 || paused) {
  nextRunAt = null
  return
 }
 const prox = obterProximaOferta()
 if(!prox){
  nextRunAt = null
  return
 }
 if(!podeEnviarAgora()){
  return
 }
 const oferta = fila.splice(prox.index,1)[0]
 await enviarOferta(oferta)
 if(fila.length===0){
  nextRunAt = null
  return
 }
 const delayMs = proximoDelayMs()
 nextRunAt = Date.now() + delayMs
 timer = setTimeout(async()=>{
  if(!conectado || paused) return
  if(fila.length===0){
   nextRunAt = null
   return
  }
  const prox2 = obterProximaOferta()
  if(!prox2){
   nextRunAt = null
   return
  }
  if(!podeEnviarAgora()){
   return
  }
  const oferta2 = fila.splice(prox2.index,1)[0]
  await enviarOferta(oferta2)
  iniciarPostagem()
 }, delayMs)
}

function montarTextoOferta(precoAntigo, precoNovo, linkProduto, nomeProduto){
 const linhaPreco = `${precoAntigo || "-"} por ${precoNovo || "-"}`
 const linhaLink = `${linkProduto ? linkProduto : "-"}`
 const linhaNome = `${nomeProduto ? nomeProduto : ""}`.trim()
 return `\u{1F525}Oferta imperdivel\u{1F525}
${linhaNome}
${linhaPreco}
\u{1F6D2} ${linhaLink}`.trim()
}

function obterImagemParaEnvio(oferta){
 if(!oferta || !oferta.imagem) return null
 if(oferta.imagemFile) return oferta.imagemFile
 if(oferta.imagem.startsWith("/uploads/")){
  const nome = path.basename(oferta.imagem)
  return path.join(uploadDir, nome)
 }
 return oferta.imagem
}

function obterProximaOferta(){
 const agora = Date.now()
 let menorAgendamento = null
 for(let i=0;i<fila.length;i++){
  const o = fila[i]
  if(!o.agendadaPara){
   return {index:i, oferta:o}
  }
  if(o.agendadaPara <= agora){
   return {index:i, oferta:o}
  }
  if(menorAgendamento===null || o.agendadaPara < menorAgendamento){
   menorAgendamento = o.agendadaPara
  }
 }
 if(menorAgendamento!==null){
  const waitMs = Math.max(0, menorAgendamento - Date.now())
  nextRunAt = Date.now() + waitMs
  pararPostagem()
  timer = setTimeout(async()=>{
   if(!conectado || paused) return
   const prox = obterProximaOferta()
   if(!prox) return
   if(!podeEnviarAgora()) return
   const oferta = fila.splice(prox.index,1)[0]
   await enviarOferta(oferta)
   iniciarPostagem()
  }, waitMs)
 }
 return null
}

function proximaEmMin(){
 if(!nextRunAt) return null
 const diffMs = nextRunAt - Date.now()
 if(diffMs <= 0) return 0
 return Math.ceil(diffMs / 60000)
}

function proximaEmSeg(){
 if(!nextRunAt) return null
 const diffMs = nextRunAt - Date.now()
 if(diffMs <= 0) return 0
 return Math.ceil(diffMs / 1000)
}

function formatarTempoRestante(ts){
 if(!ts) return ""
 const diff = ts - Date.now()
 if(diff <= 0) return "agora"
 const totalSec = Math.ceil(diff/1000)
 const h = Math.floor(totalSec/3600)
 const m = Math.floor((totalSec%3600)/60)
 const s = totalSec%60
 if(h>0) return `${h}h ${m}m`
 if(m>0) return `${m}m ${s}s`
 return `${s}s`
}

app.get("/",(req,res)=>{

const proximaMin = proximaEmMin()
const proximaSeg = proximaEmSeg()
const erro = errorMsg
errorMsg = null
resetarContadoresSeNovoDia()

res.send(`
<html>
<head>
<link rel="stylesheet" href="/style.css">
</head>

<body>

<div class="topbar">
 <div class="logo">Bot de Ofertas Automatico</div>
 <div class="nav">
  <span>Configuracoes</span>
  <span>Sair</span>
 </div>
</div>

<div class="wrap">

<div class="box">

${erro ? `<div class="alert">${erro}</div>` : ""}
${pendingLimitWarning ? `
<div class="warning">
 <div>${pendingLimitWarning}</div>
 <div class="warning-actions">
  <form action="/limite-esperar" method="post"><button class="btn-secondary">Esperar</button></form>
  <form action="/limite-continuar" method="post"><button class="btn-primary">Continuar (risco)</button></form>
 </div>
</div>
` : ""}

<div class="status-row">
 <div class="stat-card blue">
  <div class="stat-icon">👥</div>
  <div class="stat-text">
   <div class="stat-label">Grupos Ativos</div>
   <div class="stat-value">${grupos.length}</div>
  </div>
 </div>
 <div class="stat-card orange">
  <div class="stat-icon">⏰</div>
  <div class="stat-text">
   <div class="stat-label">Proxima Oferta Em ${intervaloRandom ? "(aleatorio 13-18 min)" : ""}</div>
  <div class="stat-value" id="contador" data-segundos="${proximaSeg===null ? "" : proximaSeg}">${proximaMin===null ? "--" : `${proximaMin} min`}</div>
  </div>
 </div>
</div>

<div class="section">
 <div class="section-title">Envios de Hoje</div>
 <div class="envios">
  <div>Manha: <strong>${contadorEnvios.manha}</strong> / 10</div>
  <div>Tarde: <strong>${contadorEnvios.tarde}</strong> / 10</div>
  <div>Noite: <strong>${contadorEnvios.noite}</strong> / 30</div>
 </div>
</div>

${qrCode ? `<img src="${qrCode}" width="220">` : "<h3>WhatsApp conectado</h3>"}

<p>Ultimo ID capturado: ${ultimoID}</p>

<div class="section">
 <div class="section-title">Adicionar Nova Oferta</div>
 <form action="/add" method="post" class="form-row" enctype="multipart/form-data" autocomplete="off">
 <input name="nomeProduto" placeholder="Nome do produto" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <input name="descricao" placeholder="Descricao do produto" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <input name="precoAntigo" placeholder="Preco Antigo" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <input name="precoNovo" placeholder="Preco Novo" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <input name="imagem" placeholder="Imagem (Link da Imagem)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <input type="file" name="imagemUpload" accept="image/*">
 <input name="linkProduto" placeholder="Link do produto" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
 <select name="templateId">
  <option value="1">Template 1</option>
  <option value="2">Template 2</option>
 </select>
 <button class="btn-primary">Adicionar Oferta</button>
 </form>
 <form action="/testar" method="post" class="test-row">
  <button class="btn-secondary">Enviar teste agora</button>
 </form>
 <form action="/iniciar-agora" method="post" class="test-row">
  <button class="btn-primary">Iniciar agora</button>
 </form>
</div>

<div class="section">
 <div class="section-title">Fila de Ofertas Pendentes</div>
 ${fila.length===0 ? "" : `
 <form action="/enviar-agora" method="post" class="send-now">
  <select name="ofertaIndex">
   ${fila.map((o,i)=>`<option value="${i}">#${i+1} ${o.nomeProduto || "Oferta"} - ${o.precoNovo}</option>`).join("")}
  </select>
  <button class="btn-primary">Enviar oferta agora</button>
 </form>
 `}
 <div class="fila">
  ${fila.length===0 ? `<div class="empty">Nenhuma oferta pendente</div>` : fila.map((o,i)=>`
   <div class="oferta-card">
    <div class="oferta-img">${o.imagem ? `<img src="${o.imagem}">` : `<div class="noimg">Sem imagem</div>`}</div>
    <div class="oferta-body">
     ${o.nomeProduto ? `<div class="nome-produto">${o.nomeProduto}</div>` : ""}
     ${o.descricao ? `<div class="descricao-produto">${o.descricao}</div>` : ""}
     <div class="preco-antigo">De: ${o.precoAntigo}</div>
     <div class="preco-novo">Por: ${o.precoNovo}</div>
     <div class="selo">🔥 Oferta Imperdivel 🔥</div>
     ${o.agendadaPara ? `<div class="agendada">Agendada: ${new Date(o.agendadaPara).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</div>` : ""}
     ${o.agendadaPara ? `<div class="agendada">Envia em: ${formatarTempoRestante(o.agendadaPara)}</div>` : ""}
     <form action="/remove/${i}" method="post">
      <button class="btn-danger">Remover</button>
     </form>
     <form action="/agendar/${i}" method="post" class="agendar-form" autocomplete="off">
      <input type="time" name="hora" autocomplete="off">
      <input type="number" name="minutos" min="1" placeholder="Minutos" autocomplete="off">
      <button class="btn-secondary">Agendar</button>
     </form>
     ${o.agendadaPara ? `
     <form action="/cancelar-agendamento/${i}" method="post" class="agendar-form">
      <button class="btn-secondary">Cancelar agendamento</button>
     </form>
     ` : ""}
    </div>
   </div>
  `).join("")}
 </div>
</div>

<div class="section">
 <div class="section-title">Grupos Selecionados</div>
 <form action="/config" method="post" autocomplete="off">
  <textarea name="grupos" placeholder="IDs dos grupos (1 por linha)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">${grupos.join("\n")}</textarea>
  <div class="row">
   <label class="label">Tempo entre posts</label>
   <select name="intervalo">
    <option value="10" ${intervalo===10 ? "selected":""}>10 em 10 minutos</option>
    <option value="15" ${intervalo===15 ? "selected":""}>15 em 15 minutos</option>
   </select>
  </div>
  <div class="row">
   <label class="label">
    <input type="checkbox" name="intervaloRandom" ${intervaloRandom ? "checked":""}>
    Usar intervalo aleatorio entre 13 e 18 minutos
   </label>
  </div>
  <button class="btn-primary">Atualizar IDs dos Grupos</button>
 </form>
</div>

<div class="section">
 <div class="section-title">Controle</div>
 <form action="/pausar" method="post" class="test-row">
  <button class="btn-secondary">Pausar</button>
 </form>
 <form action="/retomar" method="post" class="test-row">
  <button class="btn-primary">Retomar</button>
 </form>
</div>

</div>

</div>

</div>

<script>
const el = document.getElementById("contador")
if(el && el.dataset.segundos){
 let seg = parseInt(el.dataset.segundos)
 const tick = ()=>{
  if(isNaN(seg)) return
  if(seg <= 0){
   el.textContent = "0 s"
   return
  }
  const min = Math.floor(seg / 60)
  const sec = seg % 60
  el.textContent = min>0 ? (min + " min " + sec + "s") : (sec + "s")
  seg -= 1
  setTimeout(tick,1000)
 }
 tick()
}
</script>

</body>
</html>
`)

})

app.post("/config",(req,res)=>{

grupos = req.body.grupos.split("\n").map(v=>v.trim()).filter(v=>v)

if(grupos.length===0){
 errorMsg = "Informe pelo menos um ID de grupo."
 return res.redirect("/")
}

intervalo = parseInt(req.body.intervalo)||15
intervaloRandom = req.body.intervaloRandom==="on"

iniciarPostagem()

res.redirect("/")

})

app.post("/add",upload.single("imagemUpload"),async(req,res)=>{

if(grupos.length===0){
 errorMsg = "Informe o ID do grupo antes de adicionar ofertas."
 return res.redirect("/")
}

const precoAntigo = (req.body.precoAntigo || "").trim()
const precoNovo = (req.body.precoNovo || "").trim()
const imagemLink = (req.body.imagem || "").trim()
const nomeProduto = (req.body.nomeProduto || "").trim()
const descricao = (req.body.descricao || "").trim()
const linkProduto = (req.body.linkProduto || "").trim()
const templateId = (req.body.templateId || "1").trim()

const imagemUpload = req.file ? `/uploads/${req.file.filename}` : ""
const imagemFile = req.file ? path.join(uploadDir, req.file.filename) : ""
const imagem = imagemUpload || imagemLink

fila.push({
 imagem: imagem || null,
 imagemFile: imagemFile || "",
 precoAntigo: precoAntigo || "-",
 precoNovo: precoNovo || "-",
 linkProduto: linkProduto || "",
 nomeProduto: nomeProduto || "",
 descricao: descricao || "",
 templateId,
 agendadaPara: null
})

if(timer && !nextRunAt){
 nextRunAt = Date.now() + proximoDelayMs()
}

res.redirect("/")

})

app.post("/testar",async(req,res)=>{

if(!conectado){
 errorMsg = "WhatsApp nao conectado."
 return res.redirect("/")
}

if(grupos.length===0){
 errorMsg = "Informe o ID do grupo antes de testar."
 return res.redirect("/")
}

const ofertaTeste = fila[0]

for(const g of grupos){
 try{
  const imagemParaEnvio = obterImagemParaEnvio(ofertaTeste)
  if(ofertaTeste && imagemParaEnvio){
   await sock.sendMessage(g,{
    image:{url:imagemParaEnvio},
    caption:aplicarTemplate(ofertaTeste)
   })
  }else if(ofertaTeste){
   await sock.sendMessage(g,{text:aplicarTemplate(ofertaTeste)})
  }else{
   await sock.sendMessage(g,{text:"Teste de envio do bot de ofertas"})
  }
 }catch(e){console.log(e)}
}

res.redirect("/")

})

app.post("/remove/:index",(req,res)=>{

const index = parseInt(req.params.index)
if(Number.isInteger(index) && index>=0 && index < fila.length){
 fila.splice(index,1)
}

res.redirect("/")

})

app.post("/enviar-agora",async(req,res)=>{

const index = parseInt(req.body.ofertaIndex)
if(!Number.isInteger(index) || index<0 || index>=fila.length){
 errorMsg = "Selecione uma oferta valida."
 return res.redirect("/")
}

if(!conectado || grupos.length===0){
 errorMsg = "Conecte o WhatsApp e informe o ID do grupo."
 return res.redirect("/")
}

if(!podeEnviarAgora()){
 return res.redirect("/")
}

const oferta = fila.splice(index,1)[0]

await enviarOferta(oferta)

if(fila.length===0){
 nextRunAt = null
}

res.redirect("/")

})

app.post("/agendar/:index",(req,res)=>{

const index = parseInt(req.params.index)
if(!Number.isInteger(index) || index<0 || index>=fila.length){
 return res.redirect("/")
}

const hora = (req.body.hora || "").trim()
const minutos = parseInt(req.body.minutos)
let agendarEm = null

if(hora){
 const now = new Date()
 const [hh,mm] = hora.split(":").map(v=>parseInt(v))
 const ag = new Date(now)
 ag.setHours(hh, mm, 0, 0)
 if(ag.getTime() <= now.getTime()){
  ag.setDate(ag.getDate()+1)
 }
 agendarEm = ag.getTime()
}else if(Number.isInteger(minutos) && minutos>0){
 agendarEm = Date.now() + minutos*60000
}

if(agendarEm){
 fila[index].agendadaPara = agendarEm
 iniciarPostagem()
}

res.redirect("/")

})

app.post("/cancelar-agendamento/:index",(req,res)=>{

const index = parseInt(req.params.index)
if(Number.isInteger(index) && index>=0 && index < fila.length){
 fila[index].agendadaPara = null
 iniciarPostagem()
}

res.redirect("/")

})

app.post("/iniciar-agora",async(req,res)=>{

if(!conectado || grupos.length===0){
 errorMsg = "Conecte o WhatsApp e informe o ID do grupo."
 return res.redirect("/")
}

if(fila.length===0){
 errorMsg = "Nenhuma oferta pendente."
 return res.redirect("/")
}

await iniciarAgora()

res.redirect("/")

})

app.post("/pausar",(req,res)=>{
 paused = true
 pararPostagem()
 nextRunAt = null
 pausedReason = "manual"
 cancelarRetomada()
 res.redirect("/")
})

app.post("/retomar",(req,res)=>{
 paused = false
 pausedReason = ""
 pendingLimitWarning = null
 iniciarPostagem()
 res.redirect("/")
})

app.post("/limite-esperar",(req,res)=>{
 pendingLimitWarning = null
 paused = true
 pausedReason = "limite"
 agendarRetomada()
 res.redirect("/")
})

app.post("/limite-continuar",(req,res)=>{
 pendingLimitWarning = null
 paused = false
 pausedReason = ""
 overrideLimitPeriod = periodoAtual()
 iniciarPostagem()
 res.redirect("/")
})

app.listen(3000,()=>{
console.log("Painel http://localhost:3000")
})


