const express = require('express');
const bodyParser = require('body-parser');
const venom = require('venom-bot');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);  // Configuração do Socket.IO
const authRoutes = require('./authRoutes');

let client;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));  // Pasta para servir o HTML

// Inicializa o Venom-Bot
venom
  .create({
    session: 'whatsapp-session',
  })
  .then((venomClient) => {
    client = venomClient;
    console.log('Venom iniciado com sucesso! Pronto para enviar as mensagens!');
  })
  .catch((error) => {
    console.error('Erro ao iniciar o Venom:', error);
  });

// Função para gerar atraso aleatório
function getRandomDelay(minSeconds, maxSeconds) {
  const min = minSeconds * 1000;  // Converte para milissegundos
  const max = maxSeconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Função para verificar se o limite diário foi atingido
function checkDailyLimit(progress) {
  return progress.sentToday >= 200;
}

// Rota para envio de mensagens
app.post('/send-messages', async (req, res) => {
  const { message, numbers } = req.body;

  if (!message || !numbers || numbers.length === 0) {
    return res.status(400).json({ message: 'Mensagem ou lista de números inválida.' });
  }

  const progress = readProgress();
  const today = new Date().toISOString().split('T')[0];

  // Reset do contador de mensagens para um novo dia
  if (progress.lastSentDate !== today) {
    progress.sentToday = 0;
    progress.lastSentDate = today;
    saveProgress(progress);
  }

  // Verifica o limite diário em tempo real
  if (checkDailyLimit(progress)) {
    // Emitindo evento para o front-end informar que o limite foi atingido
    io.emit('limit-reached', {
      message: 'Limite diário de 200 mensagens atingido. O envio será reiniciado amanhã.'
    });
    return res.status(400).json({ message: 'Limite diário de 200 mensagens atingido. O envio será reiniciado amanhã.' });
  }

// Verifica o horário permitido
if (!isWithinAllowedTime()) {
  io.emit('out-of-time', {
    message: 'Envio não permitido fora do horário (08:00 às 20:00).'
  });
  return res.status(400).json({ message: 'Envio não permitido fora do horário (08:00 às 20:00).' });
}

const statusList = [];
let totalSent = 0;

// Envia o total de contatos ao cliente para que ele possa exibir a quantidade total
io.emit('progress', {
  index: 0,
  totalContacts: numbers.length,  // Envia o total de contatos
  status: 'awaiting', 
  message: `Iniciando o envio para ${numbers.length} contatos...`,
});

try {
  for (let i = 0; i < numbers.length; i++) {
    // Verifica o limite diário antes de cada envio
    if (checkDailyLimit(progress)) {
      break; // Limite diário atingido, interrompe o envio
    }

    const number = numbers[i];
    const sanitizedNumber = number
      .replace(/^\+/, '') // Remove o símbolo '+'
      .replace(/(\d{5})9(\d+)/, '$1$2'); // Remove o sexto dígito '9'

    // Validação do número
    if (sanitizedNumber.length < 12 || sanitizedNumber.length > 15) {
      statusList.push(`❌ Número inválido: ${number}`);
      io.emit('progress', { 
        index: i, // Índice do contato
        totalContacts: numbers.length, // Envia o total de contatos
        status: 'awaiting', // Status inicial de aguardando
        message: `Aguardando envio para ${sanitizedNumber}` 
      });
      continue; // Pula para o próximo número
    }

    try {
      if (isWithinAllowedTime()) {
        await client.sendText(`${sanitizedNumber}@c.us`, message);
        console.log(`Mensagem enviada para ${sanitizedNumber}`);
        statusList.push(`✅ Mensagem enviada para ${sanitizedNumber}`);
        io.emit('progress', {
          index: i,
          totalContacts: numbers.length,
          status: 'success',
          message: `Enviado para ${sanitizedNumber}`,
        });
        totalSent++;
        progress.sentToday++;
        saveProgress(progress);
      } else {
        statusList.push(`❌ Envio não permitido fora do horário (08:00 às 20:00).`);
        io.emit('progress', {
          index: i,
          totalContacts: numbers.length,
          status: 'error',
          message: `Envio não permitido fora do horário.`,
        });
        break; // Encerra o envio fora do horário permitido
      }
    } catch (error) {
      // Registra erro e exibe no statusList
      if (error?.text === 'The number does not exist' || error?.status === 404) {
        console.error(`Erro: Número inexistente (${sanitizedNumber}).`);
        statusList.push(`❌ Erro ao enviar para ${sanitizedNumber}: Número inexistente.`);
        io.emit('progress', {
          index: i,
          totalContacts: numbers.length,
          status: 'error',
          message: `Número inexistente: ${sanitizedNumber}`,
        });
      } else {
        console.error(`Erro ao enviar para ${sanitizedNumber}:`, error);
        statusList.push(`❌ Erro ao enviar para ${sanitizedNumber}: ${error.message || 'Erro desconhecido'}`);
        io.emit('progress', {
          index: i,
          totalContacts: numbers.length,
          status: 'error',
          message: `Erro desconhecido ao enviar para ${sanitizedNumber}`,
        });
      }
      continue; // Pula para o próximo número
    }

    // Gera um atraso aleatório entre 5 e 60 segundos
    const delay = getRandomDelay(5, 60);
    const remainingTime = (delay / 1000).toFixed(0); // Tempo em segundos
    console.log(`Aguardando ${delay / 1000} segundos antes de continuar...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  res.json({ message: statusList });
} catch (error) {
  console.error('Erro ao enviar mensagens:', error);
  res.status(500).json({ message: ['Erro geral ao enviar mensagens.'] });
}
});


// Função para verificar se o envio está no horário permitido (08:00 às 21:00)
function isWithinAllowedTime() {
  const now = new Date();
  const currentHour = now.getHours();
  return currentHour >= 8 && currentHour < 22;
}

// Função para gerar atraso aleatório
function getRandomDelay(minSeconds, maxSeconds) {
  const min = minSeconds * 1000; // Milissegundos
  const max = maxSeconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Funções de persistência do progresso
function readProgress() {
  const fs = require('fs');
  const filePath = './progress.json';

  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (error) {
    console.error('Erro ao ler progresso:', error);
  }

  // Retorna um progresso inicial padrão
  return { sentToday: 0, lastSentDate: '' };
}

function saveProgress(progress) {
  const fs = require('fs');
  const filePath = './progress.json';

  try {
    fs.writeFileSync(filePath, JSON.stringify(progress), 'utf8');
  } catch (error) {
    console.error('Erro ao salvar progresso:', error);
  }
}


// Inicia o servidor
const PORT = 4003;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
