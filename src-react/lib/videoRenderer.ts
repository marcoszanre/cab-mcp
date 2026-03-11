/**
 * Shared concentric-rings / orb video renderer.
 *
 * Used by both the ACS video stream (canvas → MediaStream) and the
 * ParticleSpherePreview React component.  All animation is driven by
 * `time` (seconds) and two 0-1 intensity values.
 *
 * Design goals:
 *  – Visually distinct idle / processing / speaking states
 *  – Clean, modern look (big shapes, not fine particles)
 *  – Performant: ~8-12 canvas calls per frame vs 500-1000 particle draws
 *  – Looks good in small Teams video tiles (bold, high-contrast)
 */

// ── Public API ──────────────────────────────────────────────────

export interface RingsFrameParams {
  ctx: CanvasRenderingContext2D
  w: number
  h: number
  /** Monotonic time in seconds (e.g. performance.now()/1000). */
  time: number
  /** 0 → 1 smoothed processing intensity. */
  processingIntensity: number
  /** 0 → 1 smoothed speaking intensity. */
  speakingIntensity: number
}

export function renderRingsFrame({
  ctx, w, h, time,
  processingIntensity: pI,
  speakingIntensity: sI,
}: RingsFrameParams): void {
  const cx = w / 2
  const cy = h / 2
  const unit = Math.min(w, h)
  const baseR = unit * 0.18 // central orb radius

  // Combined "activeness" for shared properties
  const active = Math.max(pI, sI)

  // ── 1. Background gradient ────────────────────────────────
  drawBackground(ctx, cx, cy, w, h, active)

  // ── 2. Outer rings (always visible, breathe in idle) ──────
  drawConcentricRings(ctx, cx, cy, baseR, time, active, sI)

  // ── 3. Processing: expanding ripples + orbiting dot ───────
  if (pI > 0.01) drawProcessingEffects(ctx, cx, cy, baseR, time, pI)

  // ── 4. Speaking: pulsating core ring + radial bars ────────
  if (sI > 0.01) drawSpeakingEffects(ctx, cx, cy, baseR, time, sI)

  // ── 5. Center glow (always, intensity varies) ─────────────
  drawCenterGlow(ctx, cx, cy, baseR, time, active, sI)
}

// ── Internals ───────────────────────────────────────────────────

function drawBackground(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  w: number, h: number,
  active: number,
) {
  const hue = 28 + active * 8
  const sat = 12 + active * 15
  const l1 = 4 + active * 2
  const l2 = 10 + active * 4
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.85)
  g.addColorStop(0, `hsl(${hue}, ${sat}%, ${l2}%)`)
  g.addColorStop(1, `hsl(${hue - 3}, ${sat - 4}%, ${l1}%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

function drawConcentricRings(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseR: number,
  time: number,
  active: number,
  speaking: number,
) {
  // Gentle breathing – ±3 % at 0.5 Hz
  const breathe = 1 + Math.sin(time * 0.5 * Math.PI * 2) * 0.03

  const rings = [
    { scale: 0.75, alpha: 0.20, lw: 1.2 },
    { scale: 1.10, alpha: 0.28, lw: 1.5 },
    { scale: 1.50, alpha: 0.18, lw: 1.0 },
  ]

  for (const { scale, alpha, lw } of rings) {
    let r = baseR * scale * breathe

    // Speaking pulse per ring
    r *= 1 + speaking * 0.08 * Math.sin(time * 4 + scale * 2)

    const a = alpha + active * 0.18
    ctx.strokeStyle = `hsla(40, 65%, 55%, ${a})`
    ctx.lineWidth = lw + active * 1.2
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawProcessingEffects(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseR: number,
  time: number,
  intensity: number,
) {
  // Expanding ripple rings (3 staggered phases)
  for (let i = 0; i < 3; i++) {
    const phase = (time * 0.5 + i / 3) % 1 // 0→1 cycle
    const r = baseR * (0.6 + phase * 1.4)
    const a = intensity * (1 - phase) * 0.28
    ctx.strokeStyle = `hsla(42, 70%, 58%, ${a})`
    ctx.lineWidth = 1.2 + (1 - phase) * 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Orbiting dot
  const angle = time * 2.2
  const orbitR = baseR * 0.95
  const dx = cx + Math.cos(angle) * orbitR
  const dy = cy + Math.sin(angle) * orbitR
  const dotG = ctx.createRadialGradient(dx, dy, 0, dx, dy, 7)
  dotG.addColorStop(0, `hsla(45, 90%, 72%, ${0.85 * intensity})`)
  dotG.addColorStop(1, 'hsla(45, 90%, 72%, 0)')
  ctx.fillStyle = dotG
  ctx.beginPath()
  ctx.arc(dx, dy, 7, 0, Math.PI * 2)
  ctx.fill()

  // Spinning partial arc (loading indicator)
  const arcAngle = time * 3
  ctx.strokeStyle = `hsla(42, 80%, 60%, ${0.45 * intensity})`
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, baseR * 1.25, arcAngle, arcAngle + Math.PI * 0.7)
  ctx.stroke()
}

function drawSpeakingEffects(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseR: number,
  time: number,
  intensity: number,
) {
  // Pulsating main ring
  const pulse = 1 + intensity * 0.12 * Math.sin(time * 5)
  const r = baseR * 0.90 * pulse
  ctx.strokeStyle = `hsla(42, 85%, 62%, ${intensity * 0.65})`
  ctx.lineWidth = 3 + intensity * 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  // Radial audio bars around the ring
  const barCount = 28
  for (let i = 0; i < barCount; i++) {
    const a = (i / barCount) * Math.PI * 2 + time * 0.4
    const wave = intensity * baseR * 0.18 * Math.sin(time * 6 + i * 0.9)
    const inner = r - Math.abs(wave) * 0.5
    const outer = r + Math.abs(wave) * 0.5

    ctx.strokeStyle = `hsla(40, 78%, 60%, ${intensity * 0.35})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
    ctx.stroke()
  }
}

function drawCenterGlow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseR: number,
  time: number,
  active: number,
  speaking: number,
) {
  const breathe = Math.sin(time * 0.5 * Math.PI * 2) * 0.04
  const speakPulse = speaking * 0.12 * Math.sin(time * 4.5)
  const r = baseR * (0.55 + breathe + active * 0.15 + speakPulse)
  const a = 0.18 + active * 0.22 + speaking * 0.15

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  g.addColorStop(0, `hsla(42, 80%, 65%, ${a})`)
  g.addColorStop(0.45, `hsla(38, 70%, 50%, ${a * 0.45})`)
  g.addColorStop(1, 'hsla(35, 60%, 40%, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
}
