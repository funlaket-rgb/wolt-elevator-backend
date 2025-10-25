// Vercel Edge Function: /api/report
import { createClient } from '@supabase/supabase-js'
export const config = { runtime: 'edge' }

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

function normalizeHe(a: string) {
  return a.trim().replace(/\s+/g, ' ').replace(/[״״׳'"]/g, '').replace(/רח׳/g, 'רחוב')
}

function decideConfidence(vYes: number, vNo: number) {
  const total = vYes + vNo
  if (total === 0) return { status: 'UNKNOWN', confidence: 0.0 }
  const ratio = vYes / total
  if (ratio >= 0.7) return { status: 'YES', confidence: 0.6 + 0.4 * ratio }
  if (ratio <= 0.3) return { status: 'NO', confidence: 0.6 + 0.4 * (1 - ratio) }
  return { status: 'UNKNOWN', confidence: 0.4 }
}

export default async function handler(req: Request) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const body = await req.json() as { address: string, status: 'YES' | 'NO' }
  const addr = normalizeHe(body.address)

  let { data: b } = await supabase.from('buildings').select('*').eq('address_norm', addr).maybeSingle()
  if (!b) return new Response(JSON.stringify({ ok: false, error: 'building not found' }), { status: 400 })

  let { data: es } = await supabase.from('elevator_status').select('*').eq('building_id', b.id).maybeSingle()
  if (!es) await supabase.from('elevator_status').insert({ building_id: b.id, status: 'UNKNOWN', confidence: 0 })

  await supabase.from('reports').insert({ building_id: b.id, status: body.status })

  // אגרגציה דרך הפונקציה שהרצת ב-SQL
  const { data: aggYes } = await supabase.rpc('count_reports', { p_building_id: b.id, p_status: 'YES' })
  const { data: aggNo } = await supabase.rpc('count_reports', { p_building_id: b.id, p_status: 'NO' })

  const decision = decideConfidence(aggYes || 0, aggNo || 0)
  await supabase.from('elevator_status').update({
    status: decision.status,
    confidence: decision.confidence,
    votes_yes: aggYes || 0,
    votes_no: aggNo || 0,
    updated_at: new Date().toISOString()
  }).eq('building_id', b.id)

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}
