const mysql = require('mysql2/promise');
require('dotenv').config({ path: './config.env' });

const EMPRESA_ID = 101;
const STATUS_PRE_AGENDADO = 212;

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

function parseDatetimeBD(dtStr) {
    const [datePart, timePart] = dtStr.trim().split(' ');
    const [ano, mes, dia] = datePart.split('-').map(Number);
    const [hora, minuto] = timePart.split(':').map(Number);
    return new Date(ano, mes - 1, dia, hora, minuto, 0);
}

function sep(titulo) {
    console.log('\n' + '─'.repeat(60));
    if (titulo) console.log(' ' + titulo);
    console.log('─'.repeat(60));
}

async function testar() {
    const inicio = agoraEmBrasilia();
    sep('TESTE — BOT PRÉ-AGENDADO ELECTROLUX (1 registro)');
    console.log(`Data/hora Brasília: ${formatarDataBR(inicio)} ${inicio.toTimeString().slice(0,5)}`);

    const conn = await mysql.createConnection({
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port:     Number(process.env.DB_PORT) || 3306,
    });

    try {
        // ── 1. Regras ──────────────────────────────────────────────────────
        sep('1. REGRAS apos_vinculo (status=212 / empresa=101)');
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

        regras.forEach(r => {
            console.log(`  id=${r.id} | ${r.nome} | ${r.execucao_horas}h`);
            console.log(`  texto: ${r.texto_cliente}`);
        });

        if (regras.length === 0) {
            console.log('  Nenhuma regra encontrada. Encerrando.');
            return;
        }

        // ── 2. Buscar 1 OS elegível ────────────────────────────────────────
        sep('2. OS ELEGÍVEL (LIMIT 1)');
        const [oss] = await conn.query(`
            SELECT
                IZ.id        AS idOs,
                IZ.Sinistro,
                IZ.OS,
                (
                    SELECT CONCAT(DC.desc_data_dt, ' ', DC.desc_hora)
                    FROM descricoes DC
                    WHERE DC.desc_id_zurich   = IZ.id
                      AND DC.mudanca_status   = 1
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
            LIMIT 5
        `, [
            STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO,
            EMPRESA_ID, STATUS_PRE_AGENDADO
        ]);

        if (oss.length === 0) {
            console.log('  Nenhuma OS elegível encontrada.');
            return;
        }

        oss.forEach((os, i) => {
            console.log(`  [${i+1}] idOs=${os.idOs} | ${os.Sinistro} | dt_mudanca=${os.dt_mudanca_212 || 'N/A'}`);
        });

        // ── 3. Buscar deduplicação em lote para as 5 OSs ──────────────────
        const idsOs = oss.map(o => o.idOs);
        const [jaExecAll] = await conn.query(`
            SELECT idOs, id AS log_id, prioridade, criado_em
            FROM logs_bot_parceiros
            WHERE idOs       IN (?)
              AND empresa_id  = ?
              AND prioridade IS NOT NULL
        `, [idsOs, EMPRESA_ID]);

        const executadas = new Set(jaExecAll.map(r => `${r.idOs}-${r.prioridade}`));

        // ── 4-6. Processar cada OS ─────────────────────────────────────────
        let criacoesTotal = 0;
        const resumo = [];

        for (let i = 0; i < oss.length; i++) {
            const os = oss[i];
            sep(`OS ${i+1}/5 — idOs=${os.idOs} | ${os.Sinistro}`);

            console.log(`  serviceOrderId  : ${os.serviceOrderId}`);
            console.log(`  usuario_resp    : ${os.usuario_responsavel}`);
            console.log(`  dt_mudanca_212  : ${os.dt_mudanca_212 || '*** NÃO ENCONTRADO ***'}`);

            if (!os.dt_mudanca_212) {
                console.log('  ATENÇÃO: sem data de mudança para 212 em descricoes. Pulando.');
                resumo.push({ idOs: os.idOs, sinistro: os.Sinistro, situacao: 'SEM_DATA_MUDANCA', acoes: [] });
                continue;
            }

            // Horas passadas
            const dtMudanca     = parseDatetimeBD(os.dt_mudanca_212);
            const horasPassadas = (inicio - dtMudanca) / (1000 * 60 * 60);
            console.log(`  Horas passadas  : ${horasPassadas.toFixed(2)}h`);

            // Payload base
            const payloadBase    = typeof os.ultimo_payload === 'string'
                ? JSON.parse(os.ultimo_payload)
                : (os.ultimo_payload || {});
            const detalhesAtuais = payloadBase?.faultCode?.performedServiceDetails || '';

            // Regras já disparadas para esta OS
            const jaExecOs = jaExecAll.filter(r => r.idOs === os.idOs);
            if (jaExecOs.length > 0) {
                console.log(`  Regras já exec  : ${jaExecOs.map(r => `prioridade=${r.prioridade}`).join(', ')}`);
            } else {
                console.log(`  Regras já exec  : nenhuma`);
            }

            const acoesOs = [];

            for (const regra of regras) {
                const chave = `${os.idOs}-${regra.id}`;

                if (horasPassadas < regra.execucao_horas) {
                    const faltam = (regra.execucao_horas - horasPassadas).toFixed(1);
                    console.log(`  [${regra.execucao_horas}h] AGUARDANDO — faltam ${faltam}h`);
                    acoesOs.push({ regra: regra.nome, status: `AGUARDANDO (${faltam}h restantes)` });
                    continue;
                }

                if (executadas.has(chave)) {
                    console.log(`  [${regra.execucao_horas}h] JÁ EXECUTADA — prioridade=${regra.id} já existe`);
                    acoesOs.push({ regra: regra.nome, status: 'JÁ EXECUTADA' });
                    continue;
                }

                // Construir e inserir
                const textoNovo     = substituirVariaveis(regra.texto_cliente, inicio);
                const novosDetalhes = detalhesAtuais
                    ? `${detalhesAtuais}\n\n${textoNovo}`
                    : textoNovo;

                const novoPayload = {
                    faultCode: {
                        ...(payloadBase.faultCode || {}),
                        performedServiceDetails: novosDetalhes
                    },
                    serviceOrderId: payloadBase.serviceOrderId || os.serviceOrderId
                };

                const [result] = await conn.query(`
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

                executadas.add(chave);
                criacoesTotal++;

                console.log(`  [${regra.execucao_horas}h] INSERIDO — log_id=${result.insertId} | prioridade=${regra.id}`);
                console.log(`     performedServiceDetails:`);
                console.log('     ' + novosDetalhes.replace(/\n/g, '\n     '));

                acoesOs.push({ regra: regra.nome, status: `INSERIDO log_id=${result.insertId}` });
            }

            resumo.push({ idOs: os.idOs, sinistro: os.Sinistro, horasPassadas: horasPassadas.toFixed(2), acoes: acoesOs });
        }

        // ── 7. Confirmação no banco para as 5 OSs ─────────────────────────
        sep('7. CONFIRMAÇÃO NO BANCO — TODOS OS REGISTROS COM PRIORIDADE');
        const [registrosCriados] = await conn.query(`
            SELECT id, idOs, serviceOrderId, acao, endpoint, status_code,
                   prioridade, criado_em, resultado
            FROM logs_bot_parceiros
            WHERE idOs       IN (?)
              AND empresa_id  = ?
              AND prioridade IS NOT NULL
            ORDER BY idOs ASC, id DESC
        `, [idsOs, EMPRESA_ID]);

        if (registrosCriados.length === 0) {
            console.log('  Nenhum registro com prioridade encontrado.');
        } else {
            registrosCriados.forEach(r => {
                const nomeRegra = regras.find(rg => rg.id === r.prioridade)?.nome || `id=${r.prioridade}`;
                console.log(`  log_id=${r.id} | idOs=${r.idOs} | ${r.serviceOrderId} | prioridade=${r.prioridade} (${nomeRegra}) | resultado=${r.resultado ?? 'NULL(pendente)'}`);
            });
        }

        // ── 8. Resumo final ────────────────────────────────────────────────
        sep(`RESUMO — ${criacoesTotal} registro(s) inserido(s) nesta execução`);
        resumo.forEach((r, i) => {
            console.log(`\n  [${i+1}] idOs=${r.idOs} | ${r.sinistro} | ${r.horasPassadas ?? '?'}h passadas`);
            r.acoes.forEach(a => console.log(`       ${a.regra}: ${a.status}`));
        });

    } finally {
        await conn.end();
    }
}

testar().catch(err => {
    console.error('\nERRO:', err.message);
    console.error(err.stack);
    process.exit(1);
});
