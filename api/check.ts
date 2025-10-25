// Vercel Edge Function: /api/check
import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

function normalizeHe(a: string) {
  return a.trim()
    .replace(/\s+/g, ' ')
    .replace(/[״״׳'"]/g, '')
    .replace(/רח׳/g, 'רחוב')
}

async function geocode(address: string) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', address)
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '1')
  const r = await fetch(url, { headers: { 'User-Agent': 'wolt-elevator-mvp/1.0' } })
  const arr = await r.json() as any[]
  if (!arr?.length) return null
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) }
}

async function queryOverpass(lat: number, lng: number) {
  const q = `
    [out:json][timeout:10];
    (
      node(around:25, ${lat}, ${lng})["wheelchair"="yes"];
      node(around:25, ${lat}, ${lng})["elevator"="yes"];
      way(around:25, ${lat}, ${lng})["elevator"="yes"];
    );
    out body; >; out skel qt;`
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: q
  })
  const json = await r.json()
  return (json.elements?.length ?? 0) > 0
}

function decideConfidence(vYes: number, vNo: number, osmYes: boolean) {
  if (osmYes) return { status: 'YES', confidence: 0.8 }
  const total = vYes + vNo
  if (total === 0) return { status: 'UNKNOWN', confidence: 0.0 }
  const ratio = vYes / total
  if (ratio >= 0.7) return { status: 'YES', confidence: 0.6 + 0.4 * ratio }
  if (ratio <= 0.3) return { status: 'NO', confidence: 0.6 + 0.4 * (1 - ratio) }
  return { status: 'UNKNOWN', confidence: 0.4 }
}

export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('address') || ''
  if (!raw) return new Response(JSON.stringify({ error: 'address required' }), { status: 400 })

  const address_norm = normalizeHe(raw)

  // 1) חפש/צור בניין
  let { data: b, error: e1 } = await supabase
    .from('buildings').select('*').eq('address_norm', address_norm).maybeSingle()

  if (!b) {
    const geo = await geocode(address_norm)
    const ins = await supabase
      .from('buildings')
      .insert({ address_norm, lat: geo?.lat, lng: geo?.lng })
      .select('*')
    b = ins.data?.[0]
  }

  if (!b) {
    return new Response(JSON.stringify({ status: 'UNKNOWN', confidence: 0, normalized_address: address_norm }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // 2) סטטוס מעלית
  let { data: es } = await supabase
    .from('elevator_status')
    .select('*').eq('building_id', b.id).maybeSingle()

  if (!es) {
    const osmYes = (b.lat && b.lng) ? await queryOverpass(b.lat, b.lng) : false
    const decision = decideConfidence(0, 0, osmYes)
    const ins = await supabase.from('elevator_status').insert({
      building_id: b.id,
      status: decision.status,
      confidence: decision.confidence
    }).select('*')
    es = ins.data?.[0]
  }

  return new Response(JSON.stringify({
    status: es.status,
    confidence: es.confidence,
    normalized_address: address_norm
  }), { headers: { 'Content-Type': 'application/json' } })
}
