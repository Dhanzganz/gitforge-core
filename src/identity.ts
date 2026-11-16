// The forge's provisioned identities.
//
// A self-hosted forge knows its users because they were provisioned into it, the way a
// company GitHub Enterprise instance knows its accounts. This deployment carries one
// provisioned directory: the account the access token belongs to (the viewer), the other
// accounts on the instance, and the organisation. The directory is derived from a fixed
// seed with the small deterministic generator below (FNV-1a + splitmix64 seeding an
// xorshift64* stream), so the same deployment always provisions the same logins, ids and
// emails — no clock, no randomness, nothing read from the environment.

const U64_MASK = 0xffffffffffffffffn;
/** The deployment seed every provisioned byte derives from. */
const DIRECTORY_SEED = 0x6a09e667f3bcc909n;

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from. */
function seedFor(label: string): bigint {
  return mix64(DIRECTORY_SEED ^ fnv1a64(label));
}

/** xorshift64*: a deterministic 64-bit stream. */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? DIRECTORY_SEED : masked;
  }

  static fromLabel(label: string): Rng {
    return new Rng(seedFor(label));
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const NAME_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const NAME_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

/** One provisioned account on this forge. */
export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, deterministic for `rng`. */
function generateUsers(rng: Rng, count: number): ForgeUser[] {
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The provisioned directory: every account this forge serves. */
export const USERS: readonly ForgeUser[] = generateUsers(Rng.fromLabel('users'), 12);
/** The account the access token belongs to: the first provisioned user. */
export const VIEWER: ForgeUser = USERS[0] as ForgeUser;
/** A second account, used as "another user" wherever an owner must not match. */
export const TEAMMATE: ForgeUser = USERS[1] as ForgeUser;
/** A third account with no rights on the viewer's repositories. */
export const STRANGER: ForgeUser = USERS[2] as ForgeUser;

/** The provisioned organisation's login, derived the same way. */
export const ORG_LOGIN: string = (() => {
  const rng = Rng.fromLabel('org');
  return `${rng.pick(NAME_ADJECTIVES)}-${rng.pick(NAME_NOUNS)}-org`;
})();

/** Look a provisioned user up by login (undefined when the login is not provisioned). */
export function userByLogin(login: string): ForgeUser | undefined {
  return USERS.find((user) => user.login === login);
}
