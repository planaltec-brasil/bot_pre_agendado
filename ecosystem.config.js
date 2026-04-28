module.exports = {
    apps: [{
        name: 'bot_pre_agendado',
        script: 'index.js',
        autorestart: true,
        watch: false,
        max_memory_restart: '200M',
        env: {
            NODE_ENV: 'production'
        }
    }]
};
