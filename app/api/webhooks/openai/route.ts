/*
  Webhook to receive OpenAI Workflows events and persist a specific agent's
  final output to Google Sheets using a Google Service Account.

  Env required (set in Vercel):
  - OPENAI_WEBHOOK_SECRET
  - GOOGLE_SA_CLIENT_EMAIL
  - GOOGLE_SA_PRIVATE_KEY
  - GOOGLE_SHEETS_ID
  - GOOGLE_SHEETS_TAB
  - TARGET_AGENT_ID (or TARGET_AGENT_NAME)
*/

import type { NextRequest } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: "Missing OPENAI_WEBHOOK_SECRET" }, 500);
  }

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Verify signature (HMAC SHA256 of raw body with shared secret)
  const providedSig =
    request.headers.get("OpenAI-Signature") ||
    request.headers.get("x-openai-signature") ||
    "";

  const valid = verifyHmacSha256(rawBody, secret, providedSig);
  if (!valid) {
    return json({ error: "Invalid signature" }, 401);
  }

  // Parse payload
  let evt: Record<string, unknown> | null = null;
  try {
    evt = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!evt) {
    return json({ error: "Empty event" }, 400);
  }

  // Only handle completion events (name varies; handle common cases)
  const eventType: string = String((evt["type"] ?? evt["event"]) ?? "");
  if (!/completed/i.test(eventType)) {
    return json({ ok: true, ignored: true });
  }

  const targetAgentId = process.env.TARGET_AGENT_ID?.trim() || "";
  const targetAgentName = process.env.TARGET_AGENT_NAME?.trim() || "";

  const agent = extractAgent(evt);
  const agentId = agent?.id ?? "";
  const agentName = agent?.name ?? "";

  // Filter for the target agent
  if (targetAgentId) {
    if (!agentId || agentId !== targetAgentId) {
      return json({ ok: true, ignored: true, reason: "agent_id mismatch" });
    }
  } else if (targetAgentName) {
    if (!agentName || agentName !== targetAgentName) {
      return json({ ok: true, ignored: true, reason: "agent_name mismatch" });
    }
  } else {
    // If no filter provided, accept all (or tighten if you prefer)
  }

  const runId = String(
    evt["run_id"] ?? (isObj(evt["run"]) ? (evt["run"] as Record<string, unknown>)["id"] : undefined) ?? ""
  );
  const userId = String(
    evt["user_id"] ??
      (isObj(evt["scope"]) ? (evt["scope"] as Record<string, unknown>)["user_id"] : undefined) ??
      (isObj(evt["run"]) ? (evt["run"] as Record<string, unknown>)["user_id"] : undefined) ??
      ""
  );
  const payloadData = extractAgentResult(evt);

  // Append to Google Sheets
  try {
    await appendToSheet({
      timestamp: new Date().toISOString(),
      runId,
      agentId,
      agentName,
      userId,
      dataJson: payloadData ? JSON.stringify(payloadData) : "",
    });
  } catch (error) {
    console.error("[webhook] Failed to append to Google Sheets", error);
    return json({ error: "Sheets append failed" }, 500);
  }

  return json({ ok: true });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyHmacSha256(body: string, secret: string, provided: string): boolean {
  try {
    const h = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    // Constant-time comparison
    const a = Buffer.from(h);
    const b = Buffer.from(provided.replace(/^sha256=/, ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractAgent(evt: Record<string, unknown>): { id?: string; name?: string } | null {
  // Try several common shapes
  const rootAgent = isObj(evt["agent"]) ? (evt["agent"] as Record<string, unknown>) : null;
  const targetAgent = isObj(evt["target_agent"]) ? (evt["target_agent"] as Record<string, unknown>) : null;
  const fromRoot = rootAgent || targetAgent;
  if (fromRoot) return { id: asString(fromRoot["id"]), name: asString(fromRoot["name"]) };

  const step = isObj(evt["step"]) ? (evt["step"] as Record<string, unknown>) : null;
  const run = isObj(evt["run"]) ? (evt["run"] as Record<string, unknown>) : null;
  const lastStep = isObj(run?.["last_step"]) ? (run?.["last_step"] as Record<string, unknown>) : null;
  const stepAgent = isObj(step?.["agent"]) ? (step?.["agent"] as Record<string, unknown>) : null;
  const runLastStepAgent = isObj(lastStep?.["agent"]) ? (lastStep?.["agent"] as Record<string, unknown>) : null;
  const fromStep = stepAgent || runLastStepAgent || null;
  if (fromStep) return { id: asString(fromStep["id"]), name: asString(fromStep["name"]) };

  const id = (evt["agent_id"]) ?? (isObj(step) ? step["agent_id"] : undefined) ?? (isObj(run) ? run["agent_id"] : undefined);
  const name = (evt["agent_name"]) ?? (isObj(step) ? step["agent_name"] : undefined) ?? (isObj(run) ? run["agent_name"] : undefined);
  if (id || name) return { id: asString(id), name: asString(name) };
  return null;
}

function extractAgentResult(evt: Record<string, unknown>): unknown {
  // Common places where final payload may live
  return (
    evt["result"] ??
    evt["output"] ??
    evt["data"] ??
    (isObj(evt["step"]) ? (evt["step"] as Record<string, unknown>)["result"] : undefined) ??
    (isObj(evt["step"]) ? (evt["step"] as Record<string, unknown>)["output"] : undefined) ??
    (isObj(evt["run"]) ? (evt["run"] as Record<string, unknown>)["result"] : undefined) ??
    null
  );
}

async function appendToSheet(params: {
  timestamp: string;
  runId: string;
  agentId: string;
  agentName: string;
  userId: string;
  dataJson: string;
}): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const sheetTab = process.env.GOOGLE_SHEETS_TAB || "Sheet1";
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_SA_PRIVATE_KEY;

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error("Missing Google Sheets env vars");
  }

  // Vercel often stores multiline keys with literal \n sequences
  privateKey = privateKey.replace(/\\n/g, "\n");

  const { google } = await import("googleapis");
  const auth = new (await import("google-auth-library")).JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const range = `${sheetTab}!A:Z`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        params.timestamp,
        params.runId,
        params.agentId,
        params.agentName,
        params.userId,
        params.dataJson,
      ]],
    },
  });
}


