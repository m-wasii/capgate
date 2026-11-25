import type { Decision, Meter, Policy } from "./policy.js";

export interface CloudStatus {
  policy: Policy;
  meter: Meter;
}

export interface ApprovalRecord {
  id: string;
  toolName: string;
  args: unknown;
  status: "pending" | "approved" | "denied";
}

export async function cloudStatus(baseUrl: string, apiKey: string): Promise<CloudStatus> {
  const res = await fetch(`${baseUrl}/api/v1/status`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as CloudStatus;
}

export async function cloudDecide(
  baseUrl: string,
  apiKey: string,
  toolName: string,
): Promise<Decision & { approvalId?: string }> {
  const res = await fetch(`${baseUrl}/api/v1/decide`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ toolName }),
  });
  if (!res.ok) throw new Error(`decide ${res.status}`);
  return (await res.json()) as Decision & { approvalId?: string };
}

export async function cloudCreateApproval(
  baseUrl: string,
  apiKey: string,
  toolName: string,
  args: unknown,
): Promise<ApprovalRecord> {
  const res = await fetch(`${baseUrl}/api/v1/approvals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ toolName, args }),
  });
  if (!res.ok) throw new Error(`approvals ${res.status}`);
  return (await res.json()) as ApprovalRecord;
}

export async function cloudGetApproval(
  baseUrl: string,
  apiKey: string,
  id: string,
): Promise<ApprovalRecord> {
  const res = await fetch(`${baseUrl}/api/v1/approvals/${id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`approval ${res.status}`);
  return (await res.json()) as ApprovalRecord;
}

export async function cloudCommit(
  baseUrl: string,
  apiKey: string,
  toolName: string,
  approvalId?: string,
): Promise<CloudStatus> {
  const res = await fetch(`${baseUrl}/api/v1/commit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ toolName, approvalId }),
  });
  if (!res.ok) throw new Error(`commit ${res.status}`);
  return (await res.json()) as CloudStatus;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
