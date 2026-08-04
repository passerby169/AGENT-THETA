"use client"

import { useEffect, useRef } from "react"

export interface ParticlesBgProps {
  /** CSS z-index (default -1, behind content) */
  zIndex?: number
  /** Canvas opacity 0–1 (default 0.35) */
  opacity?: number
  /** Line/dot color as "r,g,b" (default blue) */
  color?: string
  /** Number of floating particles (default 80) */
  count?: number
  /** Optional className for the wrapper */
  className?: string
}

export function ParticlesBg({
  zIndex = -1,
  opacity = 0.35,
  color = "59, 130, 246",
  count = 80,
  className = "",
}: ParticlesBgProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const mouseRef = useRef<{ x: number | null; y: number | null }>({ x: null, y: null })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const canvasElement = canvas
    const context = ctx

    let width = window.innerWidth
    let height = window.innerHeight

    function setSize() {
      width = window.innerWidth
      height = window.innerHeight
      canvasElement.width = width
      canvasElement.height = height
    }

    setSize()
    const onResize = () => setSize()
    window.addEventListener("resize", onResize)

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX
      mouseRef.current.y = e.clientY
    }
    const onMouseOut = () => {
      mouseRef.current.x = null
      mouseRef.current.y = null
    }
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseout", onMouseOut)

    type Particle = { x: number; y: number; xa: number; ya: number; max: number }
    type PointerParticle = Omit<Particle, "x" | "y"> & { x: number | null; y: number | null }
    const mouse: PointerParticle = {
      x: null,
      y: null,
      xa: 0,
      ya: 0,
      max: 20000,
    }

    const particles: Particle[] = []
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        xa: 2 * Math.random() - 1,
        ya: 2 * Math.random() - 1,
        max: 6000,
      })
    }

    const list = [...particles, mouse]

    function draw() {
      context.clearRect(0, 0, width, height)

      mouse.x = mouseRef.current.x
      mouse.y = mouseRef.current.y

      particles.forEach((p, i) => {
        p.x += p.xa
        p.y += p.ya
        if (p.x > width || p.x < 0) p.xa *= -1
        if (p.y > height || p.y < 0) p.ya *= -1
        context.fillStyle = `rgba(${color}, 0.6)`
        context.fillRect(p.x - 0.5, p.y - 0.5, 1, 1)

        for (let j = i + 1; j < list.length; j++) {
          const n = list[j]
          if (n.x == null || n.y == null) continue
          const dx = p.x - n.x
          const dy = p.y - n.y
          const distSq = dx * dx + dy * dy
          if (distSq >= n.max) continue

          const t = (n.max - distSq) / n.max
          context.beginPath()
          context.lineWidth = t / 2
          context.strokeStyle = `rgba(${color}, ${t + 0.2})`
          context.moveTo(p.x, p.y)
          context.lineTo(n.x, n.y)
          context.stroke()

          if (n === mouse && distSq >= n.max / 2) {
            p.x -= 0.03 * dx
            p.y -= 0.03 * dy
          }
        }
      })

      rafRef.current = requestAnimationFrame(draw)
    }

    const t = setTimeout(() => draw(), 100)

    return () => {
      clearTimeout(t)
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseout", onMouseOut)
    }
  }, [color, count])

  return (
    <div
      className={className}
      style={{
        position: "fixed",
        inset: 0,
        zIndex,
        opacity,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  )
}
