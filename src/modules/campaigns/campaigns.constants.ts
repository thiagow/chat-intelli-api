export const CAMPAIGNS_QUEUE = 'campaigns';

export const CAMPAIGN_JOBS = {
  VALIDATE_NUMBERS: 'validate-numbers',
  SUBMIT_BATCH: 'submit-batch',
  WINDOW_GUARD: 'window-guard',
  RECONCILE: 'reconcile',
  SENDER_EVENT: 'sender-event',
} as const;

/** Palavras que, em match exato (normalizado), contam como opt-out. */
export const OPT_OUT_KEYWORDS = ['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'DESCADASTRAR'] as const;

export const OPT_OUT_FOOTER = 'Responda SAIR para não receber mais mensagens.';

export const CAMPAIGN_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxMessageChars: 4096,
  maxDailyCap: 1000,
  /** Lote = uma pasta na UaZAPI; lotes menores espalham melhor o envio. */
  maxBatchSize: 500,
  minBatchPauseSec: 60,
  maxBatchPauseSec: 10_800,
  minDelaySec: 10,
  maxDelaySec: 600,
  checkBatchSize: 50,
  /** Amostra mínima de envios antes de a taxa de falha poder pausar. */
  autoPauseMinSample: 30,
  reconcileIntervalMs: 60_000,
} as const;

/** Estados em que a campanha ocupa o canal (espelha o índice parcial do banco). */
export const ACTIVE_CAMPAIGN_STATUSES = ['SUBMITTING', 'SCHEDULED', 'RUNNING', 'PAUSED'] as const;
