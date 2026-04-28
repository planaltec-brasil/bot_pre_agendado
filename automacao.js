const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: './config.env' });

const LOGS_DIR = path.join(__dirname, 'logs');
const ESTADO_FILE = path.join(__dirname, 'estado.json');
const EMPRESA_ID = 101;
const STATUS_PRE_AGENDADO = 212;

// ─── Estado ───────────────────────────────────────────────────────────────────

function lerEstado() {
    if (!fs.existsSync(ESTADO_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return null; }
}

function salvarEstado(dados) {
    fs.writeFileSync(ESTADO_FILE, JSON.stringify(dados, null, 2), 'utf8');
}

// ─── Log diário ───────────────────────────────────────────────────────────────

function salvarLog(entrada) {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const arquivo = path.join(LOGS_DIR, `${hoje}.json`);
    let conteudo = { data: hoje, execucoes: [] };
    if (fs.existsSync(arquivo)) {
        try { conteudo = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch {}
    }
    conteudo.execucoes.push(entrada);
    fs.writeFileSync(arquivo, JSON.stringify(conteudo, null, 2), 'utf8');
    console.log(`  Log salvo: logs/${hoje}.json`);
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

function agoraEmBrasilia() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function formatarDataBR(date) {
    const dia = String(date.getDate()).padStart(2, '0');
    const mes = String(date.getMonth() + 1).padStart(2, '0');
    return `${dia}/${mes}/${date.getFullYear()}`;
}

function substituirVariaveis(texto, data) {
    return texto.replace(/\{\{dataAtual\}\}/g, formatarDataBR(data));
}

// Parseia "2026-04-27 10:36" como horário local (Brasília)
function parseDatetimeBD(dtStr) {
    const [datePart, timePart] = dtStr.trim().split(' ');
    const [ano, mes, dia] = datePart.split('-').map(Number);
    const [hora, minuto] = timePart.split(':').map(Number);
    return new Date(ano, mes - 1, dia, hora, minuto, 0);
}

// ─── Execução principal ───────────────────────────────────────────────────────

async function executar(motivo = 'agendado') {
    const inicio = agoraEmBrasilia();
    console.log(`[${inicio.toISOString()}] Iniciando bot pré-agendado Electrolux (motivo: ${motivo})...`);

    salvarEstado({ status: 'executando', motivo, inicio: inicio.toISOString(), fim: null, concluido: false });

    const logEntrada = {
        horario_inicio: inicio.toISOString(),
        horario_fim: null,
        motivo,
        duracao_segundos: null,
        os_encontradas: 0,
        acoes_criadas: 0,
        detalhes: [],
        erro: null
    };

    let conn;
    try {
        conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: Number(process.env.DB_PORT) || 3306,
        });

        // 1. Buscar regras apos_vinculo ativas para status 212 / empresa 101
        const [regras] = await conn.query(`
            SELECT RG.id, RG.nome, RG.texto_cliente, RG.execucao_horas
            FROM regras RG
            INNER JOIN regras_empresas RE ON RE.regra_id = RG.id
            WHERE RG.status_id    = ?
              AND RE.empresa_id   = ?
              AND RG.execucao_modo = 'apos_vinculo'
              AND RG.ativo        = 1
            ORDER BY RG.execucao_horas ASC
        `, [STATUS_PRE_AGENDADO, EMPRESA_ID]);

        if (regras.length === 0) {
            console.log('  Nenhuma regra apos_vinculo encontrada. Encerrando.');
            return;
        }
        console.log(`  Regras: ${regras.map(r => `${r.nome} (${r.execucao_horas}h)`).join(' | ')}`);

        // 2. Buscar OSs elegíveis: status 212, empresa 101, ativas, com log inicial criado
        const [oss] = await conn.query(`
            SELECT
                IZ.id        AS idOs,
                IZ.Sinistro,
                IZ.OS,
                (
                    SELECT CONCAT(DC.desc_data_dt, ' ', DC.desc_hora)
                    FROM descricoes DC
                    WHERE DC.desc_id_zurich  = IZ.id
                      AND DC.mudanca_status  = 1
                      AND DC.status_posterior = ?
                      AND (
                          DC.desc_descricao LIKE "%para 'PRÉ AGENDADO '%"
                          OR DC.desc_descricao LIKE "%para 'PRÉ AGENDADO'%"
                      )
                    ORDER BY DC.desc_id DESC
                    LIMIT 1
                ) AS dt_mudanca_212,
                (
                    SELECT LB.payload
                    FROM logs_bot_parceiros LB
                    WHERE LB.idOs       = IZ.id
                      AND LB.empresa_id = ?
                      AND LB.status_code = ?
                    ORDER BY LB.id DESC
                    LIMIT 1
                ) AS ultimo_payload,
                (
                    SELECT LB.serviceOrderId
                    FROM logs_bot_parceiros LB
                    WHERE LB.idOs       = IZ.id
                      AND LB.empresa_id = ?
                      AND LB.status_code = ?
                    ORDER BY LB.id DESC
                    LIMIT 1
                ) AS serviceOrderId,
                (
                    SELECT LB.usuario_responsavel
                    FROM logs_bot_parceiros LB
                    WHERE LB.idOs       = IZ.id
                      AND LB.empresa_id = ?
                      AND LB.status_code = ?
                    ORDER BY LB.id DESC
                    LIMIT 1
                ) AS usuario_responsavel
            FROM importados_zurich IZ
            WHERE IZ.id_emp      = ?
              AND IZ.status      = ?
              AND IZ.AtivoInativo = 1
              AND EXISTS (
                  SELECT 1
                  FROM logs_bot_parceiros LB2
                  WHERE LB2.idOs       = IZ.id
                    AND LB2.empresa_id = ?
                    AND LB2.status_code = ?
              )
        `, [
            STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO
        ]);

        logEntrada.os_encontradas = oss.length;
        console.log(`  OSs com status 212 encontradas: ${oss.length}`);

        if (oss.length === 0) return;

        // 3. Buscar em lote quais regras já foram disparadas para essas OSs
        const idsOs = oss.map(o => o.idOs);
        const [jaExecutadas] = await conn.query(`
            SELECT idOs, prioridade
            FROM logs_bot_parceiros
            WHERE idOs       IN (?)
              AND empresa_id  = ?
              AND prioridade IS NOT NULL
        `, [idsOs, EMPRESA_ID]);

        // Lookup O(1): chave "idOs-regra_id"
        const executadas = new Set(jaExecutadas.map(r => `${r.idOs}-${r.prioridade}`));

        // 4. Para cada OS, verificar e criar ações pendentes
        for (const os of oss) {
            if (!os.dt_mudanca_212) {
                console.log(`  [idOs=${os.idOs}] Sem data de mudança para 212. Pulando.`);
                continue;
            }

            const dtMudanca   = parseDatetimeBD(os.dt_mudanca_212);
            const horasPassadas = (inicio - dtMudanca) / (1000 * 60 * 60);

            for (const regra of regras) {
                if (horasPassadas < regra.execucao_horas) continue;

                const chave = `${os.idOs}-${regra.id}`;
                if (executadas.has(chave)) continue;

                // Construir novo payload concatenando ao existente
                let novoPayload;
                try {
                    const base = typeof os.ultimo_payload === 'string'
                        ? JSON.parse(os.ultimo_payload)
                        : (os.ultimo_payload || {});

                    const textoNovo        = substituirVariaveis(regra.texto_cliente, inicio);
                    const detalhesAtuais   = base?.faultCode?.performedServiceDetails || '';
                    const novosDetalhes    = detalhesAtuais
                        ? `${detalhesAtuais}\n\n${textoNovo}`
                        : textoNovo;

                    novoPayload = {
                        faultCode: {
                            ...(base.faultCode || {}),
                            performedServiceDetails: novosDetalhes
                        },
                        serviceOrderId: base.serviceOrderId || os.serviceOrderId
                    };
                } catch (e) {
                    console.error(`  [idOs=${os.idOs}] Erro ao construir payload: ${e.message}`);
                    continue;
                }

                // Inserir registro pendente — o bot externo irá processá-lo
                await conn.query(`
                    INSERT INTO logs_bot_parceiros
                        (idOs, serviceOrderId, empresa_id, acao, endpoint,
                         payload, status_code, origem, usuario_responsavel, prioridade)
                    VALUES (?, ?, ?, 'Editar mensagem', 'editar-os-electrolux',
                            ?, ?, 'editar-os-electrolux', ?, ?)
                `, [
                    os.idOs,
                    novoPayload.serviceOrderId,
                    EMPRESA_ID,
                    JSON.stringify(novoPayload),
                    STATUS_PRE_AGENDADO,
                    os.usuario_responsavel || '39',
                    regra.id
                ]);

                // Evitar duplicação na mesma rodada
                executadas.add(chave);

                logEntrada.acoes_criadas++;
                logEntrada.detalhes.push({
                    idOs:          os.idOs,
                    sinistro:      os.Sinistro,
                    os:            os.OS,
                    regra_id:      regra.id,
                    regra:         regra.nome,
                    horas_regra:   regra.execucao_horas,
                    horas_passadas: Math.floor(horasPassadas)
                });

                console.log(
                    `  [idOs=${os.idOs}] ${os.Sinistro} → "${regra.nome}"` +
                    ` (regra ${regra.execucao_horas}h | passadas ${Math.floor(horasPassadas)}h)`
                );
            }
        }

        console.log(`  Total de ações criadas: ${logEntrada.acoes_criadas}`);

    } catch (err) {
        logEntrada.erro = err.message;
        console.error(`  ERRO: ${err.message}`);
        console.error(err.stack);
    } finally {
        if (conn) await conn.end();

        const fim = agoraEmBrasilia();
        logEntrada.horario_fim      = fim.toISOString();
        logEntrada.duracao_segundos = ((fim - inicio) / 1000).toFixed(2);

        salvarLog(logEntrada);
        salvarEstado({
            status:         logEntrada.erro ? 'erro' : 'concluido',
            motivo,
            inicio:         inicio.toISOString(),
            fim:            fim.toISOString(),
            concluido:      true,
            acoes_criadas:  logEntrada.acoes_criadas,
            ultimo_erro:    logEntrada.erro || null
        });
    }

    const fim = agoraEmBrasilia();
    console.log(
        `[${fim.toISOString()}] Concluído: ${logEntrada.acoes_criadas} ações` +
        ` em ${logEntrada.duracao_segundos}s`
    );
}

module.exports = { executar, lerEstado };
