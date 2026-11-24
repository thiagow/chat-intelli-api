import { assertSafeHttpsUrl, isPrivateAddress, UnsafeUrlError } from './safe-fetch';

const pub = async () => [{ address: '203.0.114.10', family: 4 }]; // público (fora dos TEST-NET)
const resolveTo = (...addrs: string[]) => async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1', '64:ff9b::1.2.3.4',
    'não-é-ip', '',
  ])('bloqueia %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '203.0.114.10', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'permite %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('assertSafeHttpsUrl', () => {
  it('aceita https público e devolve o IP validado', async () => {
    const r = await assertSafeHttpsUrl('https://hooks.exemplo.com/x?a=1', pub);
    expect(r.address).toBe('203.0.114.10');
    expect(r.family).toBe(4);
  });

  it.each([
    ['http://hooks.exemplo.com/x', /https/],
    ['ftp://hooks.exemplo.com/x', /https/],
    ['https://user:pass@hooks.exemplo.com/x', /usuário/],
    ['https://hooks.exemplo.com:8080/x', /Porta/],
    ['https://localhost/x', /Host/],
    ['https://app.localhost/x', /Host/],
    ['https://servico.internal/x', /Host/],
    ['https://impressora.local/x', /Host/],
    ['não é url', /inválida/],
  ])('recusa %s', async (url, msg) => {
    await expect(assertSafeHttpsUrl(url, pub)).rejects.toThrow(msg);
  });

  it('recusa IP literal interno, incluindo metadata de nuvem e IPv6', async () => {
    for (const u of ['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x']) {
      await expect(assertSafeHttpsUrl(u, pub)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('aceita IP literal público', async () => {
    const r = await assertSafeHttpsUrl('https://8.8.8.8/x', pub);
    expect(r.address).toBe('8.8.8.8');
  });

  it('recusa quando o nome resolve para endereço interno (DNS apontando para a rede privada)', async () => {
    await expect(assertSafeHttpsUrl('https://evil.example.com/x', resolveTo('10.0.0.8'))).rejects.toThrow(/interno/);
    await expect(assertSafeHttpsUrl('https://evil.example.com/x', resolveTo('169.254.169.254'))).rejects.toThrow(/interno/);
  });

  it('recusa DNS misto (um público e um privado): evita rebinding por round-robin', async () => {
    await expect(assertSafeHttpsUrl('https://evil.example.com/x', resolveTo('203.0.114.10', '127.0.0.1'))).rejects.toThrow(/interno/);
  });

  it('falha de DNS ou host sem endereço vira erro seguro', async () => {
    await expect(assertSafeHttpsUrl('https://nao-existe.example.com/x', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/resolver/);
    await expect(assertSafeHttpsUrl('https://vazio.example.com/x', async () => [])).rejects.toThrow(/sem endereço/);
  });

  it('portas 443 e 8443 são aceitas', async () => {
    await expect(assertSafeHttpsUrl('https://hooks.exemplo.com:443/x', pub)).resolves.toBeDefined();
    await expect(assertSafeHttpsUrl('https://hooks.exemplo.com:8443/x', pub)).resolves.toBeDefined();
  });
});
