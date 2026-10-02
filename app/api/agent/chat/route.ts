import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'
import { agentTools } from '@/lib/agent-tools'
import { runTool } from '@/lib/tool-runner'

// OpenAI-compatible endpoint. Defaults to Nebius Token Factory (Nemotron),
// but any OpenAI-compatible provider works via env overrides.
const BASE = process.env.AGENT_BASE_URL ?? 'https://api.studio.nebius.com/v1'
const API_KEY = process.env.AGENT_API_KEY ?? process.env.NEBIUS_API_KEY ?? process.env.OPENROUTER_API_KEY
const MODEL = process.env.AGENT_MODEL ?? process.env.NEBIUS_MODEL ?? 'nvidia/llama-3.1-nemotron-70b-instruct'

async function callAgent(messages: object[], tools?: object[]) {
  const body: Record<string, unknown> = { model: MODEL, messages, max_tokens: 1000 }
  if (tools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`agent provider ${res.status}: ${await res.text()}`)
  return res.json() as Promise<{
    choices: { finish_reason: string; message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
  }>
}

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })
  if (!API_KEY) return NextResponse.json({ error: 'Agent provider not configured (set AGENT_API_KEY or NEBIUS_API_KEY)' }, { status: 503 })

  const { messages, client_id, period } = await req.json()
  if (!messages || !client_id || !period) {
    return NextResponse.json({ error: 'messages, client_id, period required' }, { status: 400 })
  }

  const system = `You are a GST reconciliation assistant for a CA firm.
You have tools that query real reconciliation data for the current client and period (${period}).
Never guess or invent invoice data — always call a tool before explaining specifics.
Buckets: MATCHED (every amount within ₹1), PROBABLE (within ₹10), MISMATCH (a difference above ₹10), BOOKS_ONLY (booked, not in 2B — supplier may not have filed), TWOB_ONLY (in 2B, not booked — invoice may be missing).
Speak in clear, professional English. Keep replies concise — CAs are busy.
When drafting vendor emails, be firm but polite.`

  try {
    // Call 1: does the model need a tool?
    const r1 = await callAgent([{ role: 'system', content: system }, ...messages], agentTools)
    const choice = r1.choices[0]
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      return NextResponse.json({ reply: choice.message.content })
    }

    // Execute the tool call against Supabase
    const toolCall = choice.message.tool_calls[0]
    const toolResult = await runTool(
      toolCall.function.name,
      JSON.parse(toolCall.function.arguments),
      { db, orgId, client_id, period },
    )

    // Call 2: final plain-language reply
    const r2 = await callAgent([
      { role: 'system', content: system },
      ...messages,
      choice.message,
      { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) },
    ])
    return NextResponse.json({ reply: r2.choices[0].message.content })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
