// Configuração do pm2. Uso no Raspberry Pi (dentro de backend/):
//   pm2 delete servidor-cupons   # só na primeira vez, se já existir sem este arquivo
//   pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'servidor-cupons',
    script: 'server.js',
    cwd: __dirname,
    // Se o HD não estiver montado, o server.js sai com código 78. Em vez de
    // reiniciar em loop agressivo, espera 1 min entre tentativas — assim ele
    // volta sozinho quando o HD aparecer, sem martelar o Pi.
    restart_delay: 60000,
    // Reinícios com menos de min_uptime contam como "instáveis"; depois de
    // max_restarts seguidos (~1h com o delay acima) o pm2 desiste (status
    // "errored") até alguém rodar pm2 restart servidor-cupons.
    min_uptime: 10000,
    max_restarts: 60
  }]
};
