# Bot Pré-Agendado Electrolux — Regras de Funcionamento

## Visão Geral

Automação que monitora OSs da Electrolux em status **212 (Pré-Agendado)** e insere mensagens programadas na tabela `logs_bot_parceiros` após períodos configuráveis (ex: 24h, 48h). Um bot externo (`editar-os-electrolux`) processa esses registros e envia as mensagens.

---

## Configuração PM2

```bash
# Iniciar
pm2 start ecosystem.config.js

# Salvar para reiniciar automaticamente no boot
pm2 save
pm2 startup

# Monitorar
pm2 logs bot_pre_agendado
pm2 status
```

**Parâmetros do processo (`ecosystem.config.js`):**

| Parâmetro          | Valor              | Descrição                                  |
|--------------------|--------------------|--------------------------------------------|
| `name`             | `bot_pre_agendado` | Nome do processo no PM2                    |
| `script`           | `index.js`         | Ponto de entrada                           |
| `autorestart`      | `true`             | Reinicia automaticamente se cair           |
| `watch`            | `false`            | Não monitora alterações em arquivos        |
| `max_memory_restart` | `200M`           | Reinicia se RAM ultrapassar 200 MB         |
| `NODE_ENV`         | `production`       | Ambiente de produção                       |

---

## Agendamento de Execuções

- **Cron:** `0 7-22 * * *`
- **Horários:** Toda hora cheia das **07:00 às 22:00** (fuso `America/Sao_Paulo`)
- **Execuções por dia:** até 16 (07h, 08h, 09h, ..., 22h)

---

## Lógica de Startup (Recuperação Automática)

Ao iniciar (ou reiniciar via PM2), o sistema verifica o `estado.json` e decide se executa imediatamente:

| Condição encontrada                                   | Ação                                                         |
|-------------------------------------------------------|--------------------------------------------------------------|
| `estado.status === 'executando'`                      | Execução anterior foi interrompida (crash) → roda em 3s      |
| Sem `estado.json`                                     | Primeira execução do sistema → roda em 3s                    |
| Horas agendadas entre 7h-22h perdidas desde o último fim | Recupera as horas perdidas → roda em 3s                 |
| Em dia com o agendamento                              | Aguarda próxima hora cheia                                   |

---

## Regras de Negócio

### 1. Escopo

- **Empresa:** Electrolux (`empresa_id = 101`)
- **Status monitorado:** Pré-Agendado (`status = 212`)
- **Modo de regra:** `apos_vinculo` — disparos acontecem APÓS a OS entrar no status 212

### 2. Critérios de Elegibilidade de uma OS

Para ser processada, a OS precisa:

1. Pertencer à empresa `101` (Electrolux)
2. Estar com `status = 212` em `importados_zurich`
3. Ter `AtivoInativo = 1` (ativa)
4. Ter ao menos um registro em `logs_bot_parceiros` com `status_code = 212` (log inicial criado pelo sistema principal)
5. Possuir data de mudança para o status 212 registrada em `descricoes`

### 3. Critérios de Elegibilidade de uma Regra

Para que uma regra seja disparada para uma OS específica:

1. A regra precisa estar ativa (`ativo = 1`) e vinculada à empresa 101
2. O número de **horas passadas** desde que a OS entrou em status 212 deve ser **maior ou igual** ao `execucao_horas` da regra
3. A combinação `(idOs, regra_id)` **não pode existir** em `logs_bot_parceiros` com `prioridade IS NOT NULL` — cada regra só dispara **uma única vez por OS**

### 4. Cálculo de Tempo

```
horasPassadas = (agora_brasilia - dt_mudanca_212) / 3_600_000
```

- `dt_mudanca_212`: extraída da tabela `descricoes`, campo `desc_descricao` contendo `"para 'PRÉ AGENDADO'"`, ordenado pelo mais recente
- Se `horasPassadas < regra.execucao_horas` → aguarda próxima execução

### 5. Construção do Payload

Ao disparar uma regra, o sistema:

1. Busca o **último payload** da OS em `logs_bot_parceiros`
2. Extrai o campo `faultCode.performedServiceDetails`
3. **Concatena** o texto da regra ao texto anterior (separados por linha dupla `\n\n`)
4. Substitui `{{dataAtual}}` pela data de execução no formato `DD/MM/YYYY`
5. Monta o JSON final:

```json
{
  "faultCode": {
    "...outros campos preservados...",
    "performedServiceDetails": "<texto anterior>\n\n<texto da regra>"
  },
  "serviceOrderId": "<id da OS>"
}
```

### 6. Inserção na Fila

O registro é inserido em `logs_bot_parceiros`:

| Campo                | Valor                           |
|----------------------|---------------------------------|
| `idOs`               | ID da OS                        |
| `serviceOrderId`     | ID externo da OS                |
| `empresa_id`         | `101`                           |
| `acao`               | `'Editar mensagem'`             |
| `endpoint`           | `'editar-os-electrolux'`        |
| `payload`            | JSON construído acima           |
| `status_code`        | `212`                           |
| `origem`             | `'editar-os-electrolux'`        |
| `usuario_responsavel`| Usuário da OS (fallback: `39`)  |
| `prioridade`         | `regra.id`                      |

O bot externo `editar-os-electrolux` consome esses registros e envia para a API.

---

## Deduplicação

- **Em banco:** consulta prévia em `logs_bot_parceiros` por `(idOs, prioridade)` para identificar regras já disparadas
- **Em memória:** `Set` com chave `idOs-regra_id` atualizado durante a mesma execução
- **Resultado:** Mesmo que o bot rode várias vezes, cada combinação OS × Regra é disparada **exatamente uma vez**

---

## Persistência de Estado

**Arquivo:** `estado.json`

```json
{
  "status": "concluido",
  "motivo": "agendado_15h",
  "inicio": "2026-04-29T18:00:02.000Z",
  "fim": "2026-04-29T18:00:07.000Z",
  "concluido": true,
  "acoes_criadas": 3,
  "ultimo_erro": null
}
```

Valores possíveis de `status`: `executando`, `concluido`, `erro`

---

## Logs Diários

**Diretório:** `logs/`  
**Arquivo:** `logs/YYYY-MM-DD.json` (um por dia)

Cada execução registra:

```json
{
  "horario_inicio": "...",
  "horario_fim": "...",
  "motivo": "agendado_15h",
  "duracao_segundos": "5.82",
  "os_encontradas": 4,
  "acoes_criadas": 2,
  "detalhes": [
    {
      "idOs": 12345,
      "sinistro": "2024-00001",
      "os": "OS-001",
      "regra_id": 5,
      "regra": "Mensagem 24h",
      "horas_regra": 24,
      "horas_passadas": 25
    }
  ],
  "erro": null
}
```

---

## Tabelas do Banco (`servico_bd`)

| Tabela                | Papel no sistema                                          |
|-----------------------|-----------------------------------------------------------|
| `importados_zurich`   | OSs importadas; filtradas por empresa/status/ativo        |
| `descricoes`          | Histórico de mudanças de status (fonte do `dt_mudanca_212`) |
| `regras`              | Templates de mensagens com tempo de disparo               |
| `regras_empresas`     | Vínculo entre regras e empresas                           |
| `logs_bot_parceiros`  | Fila de ações criadas e histórico de execuções            |

---

## Variáveis de Ambiente (`config.env`)

| Variável          | Descrição                          |
|-------------------|------------------------------------|
| `DB_HOST`         | Host do banco MySQL (RDS AWS)      |
| `DB_USER`         | Usuário do banco                   |
| `DB_PASSWORD`     | Senha do banco                     |
| `DB_NAME`         | Nome do banco (`servico_bd`)       |
| `DB_PORT`         | Porta (padrão `3306`)              |

> **Importante:** `config.env` está no `.gitignore` e nunca deve ser versionado.

---

## Execução Manual (Debug)

```bash
# Execução manual direta (sem agendador)
npm run executar

# Teste com limite de 5 OSs e logs detalhados
node teste.js
```

---

## Fluxo Resumido

```
PM2 inicia index.js
       │
       ├─► Verifica estado.json
       │       ├─ Crash / horas perdidas → executa em 3s
       │       └─ Em dia → aguarda cron
       │
       └─► Cron: toda hora cheia 07h–22h
               │
               └─► automacao.executar(motivo)
                       │
                       ├─[1] Busca regras ativas (empresa=101, status=212, modo=apos_vinculo)
                       ├─[2] Busca OSs elegíveis (status=212, ativas, com log inicial)
                       ├─[3] Verifica histórico de disparos (deduplicação)
                       └─[4] Para cada OS × Regra elegível:
                               ├─ Constrói payload (concatena texto)
                               ├─ Insere em logs_bot_parceiros
                               └─ Marca como executada no Set
```
