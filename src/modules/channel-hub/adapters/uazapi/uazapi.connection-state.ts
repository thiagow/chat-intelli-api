/**
 * Interpreta a resposta de `GET /instance/status` da UaZAPI.
 *
 * Formato real observado:
 *   { instance: { status: 'connected'|'connecting'|'disconnected'|'hibernated', qrcode, paircode, … },
 *     status:   { connected: boolean, loggedIn: boolean, jid: string|null } }
 *
 * `status.connected` + `loggedIn` são os sinais mais confiáveis; `instance.status` é o rótulo.
 * Também aceita o formato legado (`state` / `status` string) usado por provedores parecidos.
 */
export interface UazapiConnectionState {
  /** true somente quando a sessão do WhatsApp está logada e conectada. */
  connected: boolean;
  /** Rótulo bruto do provider (connected, hibernated, disconnected, …). */
  state: string;
  loggedIn: boolean | null;
  /** false quando o formato não foi reconhecido (o chamador decide o que fazer). */
  recognized: boolean;
}

export function parseUazapiConnectionState(raw: any): UazapiConnectionState {
  const flag = raw?.status?.connected;
  const loggedIn = typeof raw?.status?.loggedIn === 'boolean' ? raw.status.loggedIn : null;
  const label: string | null =
    typeof raw?.instance?.status === 'string'
      ? raw.instance.status
      : typeof raw?.state === 'string'
        ? raw.state
        : typeof raw?.state?.status === 'string'
          ? raw.state.status
          : typeof raw?.status === 'string'
            ? raw.status
            : null;

  if (typeof flag === 'boolean') {
    return {
      connected: flag && loggedIn !== false,
      state: label ?? (flag ? 'connected' : 'disconnected'),
      loggedIn,
      recognized: true,
    };
  }
  if (label) {
    return {
      connected: ['connected', 'open'].includes(label.toLowerCase()),
      state: label,
      loggedIn,
      recognized: true,
    };
  }
  return { connected: false, state: 'unknown', loggedIn, recognized: false };
}

/** Texto curto, em português, para o usuário. */
export function describeUazapiState(state: string): string {
  switch (state.toLowerCase()) {
    case 'connected':
    case 'open':
      return 'conectado';
    case 'connecting':
      return 'conectando';
    case 'hibernated':
      return 'hibernada (sem sessão ativa)';
    case 'disconnected':
      return 'desconectado';
    default:
      return state;
  }
}
