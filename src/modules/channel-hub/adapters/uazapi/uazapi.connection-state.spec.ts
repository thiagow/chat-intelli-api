import { describeUazapiState, parseUazapiConnectionState } from './uazapi.connection-state';

describe('parseUazapiConnectionState', () => {
  it('instância hibernada e deslogada não está conectada', () => {
    const s = parseUazapiConnectionState({
      instance: { status: 'hibernated' },
      status: { connected: false, loggedIn: false, jid: null },
    });
    expect(s).toMatchObject({ connected: false, state: 'hibernated', loggedIn: false, recognized: true });
  });

  it('conectada e logada', () => {
    const s = parseUazapiConnectionState({
      instance: { status: 'connected' },
      status: { connected: true, loggedIn: true, jid: 'x@s.whatsapp.net' },
    });
    expect(s).toMatchObject({ connected: true, state: 'connected', recognized: true });
  });

  it('connected=true mas loggedIn=false não conta como conectada', () => {
    expect(parseUazapiConnectionState({ status: { connected: true, loggedIn: false } }).connected).toBe(false);
  });

  it('só o rótulo (sem booleanos)', () => {
    expect(parseUazapiConnectionState({ instance: { status: 'connected' } }).connected).toBe(true);
    expect(parseUazapiConnectionState({ instance: { status: 'hibernated' } }).connected).toBe(false);
  });

  it('formato legado', () => {
    expect(parseUazapiConnectionState({ status: 'connected' }).connected).toBe(true);
    expect(parseUazapiConnectionState({ state: { status: 'disconnected' } }).connected).toBe(false);
  });

  it('formato desconhecido não é tratado como conectado', () => {
    expect(parseUazapiConnectionState({})).toMatchObject({ connected: false, recognized: false });
    expect(parseUazapiConnectionState(null).recognized).toBe(false);
  });

  it('describeUazapiState traduz os rótulos', () => {
    expect(describeUazapiState('hibernated')).toContain('hibernada');
    expect(describeUazapiState('connected')).toBe('conectado');
  });
});
