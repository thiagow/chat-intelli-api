import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/**
 * Chamadas HTTP de SAÍDA para URLs informadas por usuários (webhooks). Proteção contra SSRF:
 *  - só `https`, sem credenciais na URL, portas web comuns;
 *  - o host é resolvido e QUALQUER endereço interno (loopback, privado, link-local/metadata,
 *    CGNAT, multicast, reservado) bloqueia a chamada;
 *  - o IP validado é o que de fato recebe a conexão (contra DNS rebinding), com SNI/Host do nome original;
 *  - sem seguir redirecionamentos, com timeout e limite de tamanho de resposta.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const ALLOWED_PORTS = new Set([443, 8443]);

type ResolveFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolve: ResolveFn = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** true para endereço que NÃO deve ser alcançado por uma chamada iniciada por usuário. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  const v = isIP(addr);
  if (v === 4) return isPrivateV4(addr);
  if (v === 6) return isPrivateV6(addr);
  return true; // não é IP válido: trata como inseguro
}

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reservado + broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true;
  // IPv4 mapeado (::ffff:a.b.c.d ou ::ffff:xxxx:xxxx) → avalia o IPv4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  if (ip.startsWith('64:ff9b:')) return true; // NAT64
  if (ip.startsWith('2001:db8')) return true; // documentação
  return false;
}

export interface ValidatedUrl {
  url: URL;
  /** Endereço público validado, fixado para a conexão. */
  address: string;
  family: 4 | 6;
}

/** Valida a URL e devolve o IP público a usar. Lança `UnsafeUrlError` se insegura. */
export async function assertSafeHttpsUrl(raw: string, resolve: ResolveFn = defaultResolve): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('URL inválida');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('A URL precisa usar https');
  if (url.username || url.password) throw new UnsafeUrlError('A URL não pode conter usuário/senha');
  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.has(port)) throw new UnsafeUrlError('Porta não permitida (use 443 ou 8443)');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('Host não permitido');
  }

  // Host já é um IP literal: valida direto (sem DNS).
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('Endereço interno não permitido');
    return { url, address: host, family: isIP(host) as 4 | 6 };
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeUrlError('Não foi possível resolver o endereço do host');
  }
  if (!addrs.length) throw new UnsafeUrlError('Host sem endereço');
  // Qualquer endereço interno invalida: evita que um round-robin DNS misture público e privado.
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('O host resolve para um endereço interno');
  const first = addrs[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

export interface SafePostOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolve?: ResolveFn;
}

export interface SafePostResult {
  status: number;
  /** Primeiros bytes da resposta (para log/diagnóstico). */
  bodyPreview: string;
}

/** POST de corpo JSON já serializado. Não segue redirecionamentos. */
export async function safePost(rawUrl: string, body: string, opts: SafePostOptions = {}): Promise<SafePostResult> {
  const { url, address, family } = await assertSafeHttpsUrl(rawUrl, opts.resolve);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxResponseBytes ?? 16 * 1024;

  return new Promise<SafePostResult>((resolvePromise, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: url.hostname.replace(/^\[|\]$/g, ''), // SNI e verificação do certificado pelo nome original
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'IntelliChat-Webhook/1',
          ...(opts.headers ?? {}),
        },
        // A conexão vai para o IP já validado, não para uma nova resolução (anti DNS rebinding).
        lookup: (_host, _options, cb) => (cb as any)(null, address, family),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
          else res.destroy(); // resposta grande demais: encerra sem ler o resto
        });
        const finish = () =>
          resolvePromise({ status: res.statusCode ?? 0, bodyPreview: Buffer.concat(chunks).toString('utf8').slice(0, 300) });
        res.on('end', finish);
        res.on('close', finish);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout após ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
