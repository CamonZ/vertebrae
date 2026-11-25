const MAX_PR_NUMBER = 4_294_967_295;

export type PrReference =
  | { ok: true; number: number; repo: string | null }
  | { ok: false; message: string };

function fromDigits(digits: string, repo: string | null): PrReference {
  const number = Number(digits);
  if (number < 1) return { ok: false, message: "PR numbers start at 1." };
  if (number > MAX_PR_NUMBER)
    return { ok: false, message: "That number is too large for a PR." };
  return { ok: true, number, repo };
}

function fromUrl(text: string): PrReference {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That link isn’t a valid URL." };
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  if (!match)
    return { ok: false, message: "That link isn’t a pull request URL." };
  const [, owner, name, digits] = match;
  return fromDigits(digits, `${owner}/${name}`);
}

export function parsePrReference(input: string, baseRepo: string): PrReference {
  const text = input.trim();
  if (!text)
    return { ok: false, message: "Enter a PR number, #number, or PR URL." };
  const digits = /^#?(\d+)$/.exec(text)?.[1];
  if (digits) return fromDigits(digits, null);
  if (/^https?:\/\//i.test(text)) return fromUrl(text);
  return {
    ok: false,
    message: `Enter a PR number like 482, #482, or a PR URL from ${baseRepo}.`,
  };
}
