/** The pseudo-account that spans every real one. */
export const ALL_ACCOUNTS = "all";

export interface ViewTemplate {
  name: string;
  /** Unscoped notmuch query; `scopeQuery` narrows it to an account. */
  query: string;
}

export const VIEW_TEMPLATES: ViewTemplate[] = [
  { name: "INBOX", query: "tag:inbox" },
  { name: "UNREAD", query: "tag:unread" },
  { name: "FLAGGED", query: "tag:flagged" },
  { name: "TODAY", query: "date:today" },
  { name: "SENT", query: "tag:sent" },
  { name: "DRAFTS", query: "tag:draft" },
  { name: "ARCHIVE", query: "not tag:inbox and not tag:trash" },
  { name: "ALL MAIL", query: "*" },
];

export interface AccountLike {
  id: string;
  address?: string | null;
}

export interface ViewGroup {
  account: string;
  address: string | null;
  views: { name: string; query: string }[];
}

/**
 * Narrows a view to one account. The post-new hook tags every message with its
 * account, so scoping is an `and` on that tag rather than a path prefix, which
 * keeps it working for mail filed outside the account's own folders.
 */
export function scopeQuery(query: string, account: string): string {
  if (account === ALL_ACCOUNTS) return query;

  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "*") return `tag:${account}`;

  return `(${trimmed}) and (tag:${account})`;
}

export function viewQuery(name: string, account: string): string | null {
  const template = VIEW_TEMPLATES.find((v) => v.name === name);
  return template ? scopeQuery(template.query, account) : null;
}

/**
 * Sent mail is what you sent, not what a hook happened to tag. Matching on the
 * From address catches mail sent from any client, and mail filed anywhere.
 * Without a known address there is nothing better than the tag.
 */
function sentQuery(account: string, addresses: string[]): string {
  if (addresses.length === 0) return scopeQuery("tag:sent", account);
  return addresses.map((a) => `from:${a}`).join(" or ");
}

export function buildTree(accounts: AccountLike[]): ViewGroup[] {
  const addressOf = (a: AccountLike) => a.address?.trim() ?? "";
  const everyAddress = accounts.map(addressOf).filter(Boolean);

  const group = (account: string, addresses: string[]): ViewGroup => ({
    account,
    address: addresses[0] ?? null,
    views: VIEW_TEMPLATES.map((v) => ({
      name: v.name,
      query:
        v.name === "SENT"
          ? sentQuery(account, addresses)
          : scopeQuery(v.query, account),
    })),
  });

  return [
    group(ALL_ACCOUNTS, everyAddress),
    ...accounts.map((a) => {
      const address = addressOf(a);
      return group(a.id, address ? [address] : []);
    }),
  ];
}

/**
 * Which account a query is showing, for the footer. Matches the account tag or
 * a folder path, and requires a word boundary so `tag:mainframe` is not read as
 * the `main` account.
 */
export function accountLabel(query: string, accounts: AccountLike[]): string {
  for (const account of accounts) {
    const tag = new RegExp(`tag:${escape(account.id)}(?![\\w-])`);
    const path = new RegExp(`path:"?${escape(account.id)}/`);
    if (tag.test(query) || path.test(query)) return account.id;
  }
  return ALL_ACCOUNTS;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
