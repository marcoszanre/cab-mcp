import { useEffect, useRef, useCallback } from 'react'
import { renderRingsFrame } from '@/lib/videoRenderer'

interface ParticleSpherePreviewProps {
  width?: number
  height?: number
  className?: string
}

declare global {
  interface Window {
    setAgentSpeaking?: (speaking: boolean) => void
  }
}

type PreviewVideoState = 'idle' | 'processing' | 'speaking'

/**
 * Concentric-rings / orb visualization component.
 * Renders live per-frame animation with 3 distinct states:
 *  - idle: soft breathing rings
 *  - processing: expanding ripples + orbiting dot
 *  - speaking: audio-reactive pulsating ring + radial bars
 */
export function ParticleSpherePreview({
  width = 1280,
  height = 720,
  className = '',
}: ParticleSpherePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number | null>(null)
  const videoStateRef = useRef<PreviewVideoState>('idle')
  const speakingIntensityRef = useRef(0)
  const processingIntensityRef = useRef(0)
  const visibleRef = useRef(true)
  const startTimeRef = useRef(performance.now())

  const animate = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (!visibleRef.current) {
      animationRef.current = requestAnimationFrame(animate)
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      animationRef.current = requestAnimationFrame(animate)
      return
    }

    // Smooth transitions
    const targetSpeaking = videoStateRef.current === 'speaking' ? 1 : 0
    const targetProcessing = videoStateRef.current === 'processing' ? 1 : 0
    speakingIntensityRef.current += (targetSpeaking - speakingIntensityRef.current) * 0.08
    processingIntensityRef.current += (targetProcessing - processingIntensityRef.current) * 0.08

    renderRingsFrame({
      ctx,
      w: canvas.width,
      h: canvas.height,
      time: (performance.now() - startTimeRef.current) / 1000,
      processingIntensity: processingIntensityRef.current,
      speakingIntensity: speakingIntensityRef.current,
    })

    animationRef.current = requestAnimationFrame(animate)
  }, [])

  // Speaking state listener (backward compat via window.setAgentSpeaking)
  useEffect(() => {
    const originalSetSpeaking = window.setAgentSpeaking
    window.setAgentSpeaking = (speaking: boolean) => {
      videoStateRef.current = speaking ? 'speaking' : 'idle'
      originalSetSpeaking?.(speaking)
    }
    return () => {
      if (originalSetSpeaking) {
        window.setAgentSpeaking = originalSetSpeaking
      }
    }
  }, [])

  // Pause animation when tab is hidden
  useEffect(() => {
    const onVisChange = () => { visibleRef.current = !document.hidden }
    document.addEventListener('visibilitychange', onVisChange)
    return () => document.removeEventListener('visibilitychange', onVisChange)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.width = width
    canvas.height = height

    animationRef.current = requestAnimationFrame(animate)
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
    }
  }, [width, height, animate])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', objectFit: 'contain', willChange: 'contents' }}
    />
  )
}
