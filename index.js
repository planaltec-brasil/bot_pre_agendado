const cron = require('node-cron');
const { executar, lerEstado } = require('./automacao');

// Roda a cada hora cheia (ex: 07:00, 08:00 ... 22:00) no fuso de Brasília
const HORARIOS_CRON = '0 7-22 * * *';

function agoraEmBrasilia() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function verificarExecucaoNecessaria() {
    const estado = lerEstado();

    // Processo travado na execução anterior (crash / desligamento)
    if (estado && estado.status === 'executando') {
        console.log(`[STARTUP] Execução anterior interrompida em ${estado.inicio}. Rodando imediatamente.`);
        return 'recuperacao_interrupcao';
    }

    // Primeira execução
    if (!estado) {
        console.log('[STARTUP] Nenhum estado anterior. Rodando execução inicial.');
        return 'primeira_execucao';
    }

    // Verifica se alguma hora agendada foi perdida desde a última conclusão
    if (estado.fim) {
        const agora = agoraEmBrasilia();
        const ultimoFim = new Date(
            new Date(estado.fim).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
        );
        const horaAtual = agora.getHours();

        // Horas elegíveis (7h às 22h)
        const horasElegiveis = Array.from({ length: 16 }, (_, i) => i + 7);
        const horasPerdidas = horasElegiveis.filter(h => {
            if (h > horaAtual) return false;
            const horarioAgendado = new Date(agora);
            horarioAgendado.setHours(h, 0, 0, 0);
            return ultimoFim < horarioAgendado;
        });

        if (horasPerdidas.length > 0) {
            console.log(`[STARTUP] Horário(s) perdido(s): ${horasPerdidas.map(h => h + 'h').join(', ')}. Rodando imediatamente.`);
            return `recuperacao_${horasPerdidas.join('_')}h`;
        }
    }

    return null;
}

async function run(motivo = 'agendado') {
    try {
        await executar(motivo);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ERRO crítico:`, err.message);
    }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log(`[${new Date().toISOString()}] Bot Pré-Agendado Electrolux iniciado.`);
console.log(`  Agendamento: toda hora cheia das 07:00 às 22:00 (America/Sao_Paulo)`);

const motivoImediato = verificarExecucaoNecessaria();
if (motivoImediato) {
    setTimeout(() => run(motivoImediato), 3000);
} else {
    console.log('[STARTUP] Em dia. Aguardando próxima hora agendada.');
}

// ─── Cron ─────────────────────────────────────────────────────────────────────

cron.schedule(HORARIOS_CRON, () => {
    const hora = agoraEmBrasilia().getHours();
    run(`agendado_${String(hora).padStart(2, '0')}h`);
}, { timezone: 'America/Sao_Paulo' });
