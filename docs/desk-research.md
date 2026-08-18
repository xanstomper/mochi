# Desk Design & Requirements Research

Research compiled to inform the design and implementation of the desk system.
Covers desk types, dimensions/ergonomics, and materials/structural considerations.

## 1. Key Desk Types

| Type | Description | Pros | Cons |
|------|-------------|------|------|
| **Sitting desk** | Fixed-height desk for seated work. | Simple, stable, low cost. | No posture variety; static. |
| **Standing desk** | Fixed-height desk set for standing work. | Encourages movement, reduces sedentary time. | Fatigue over long standing; single height. |
| **Adjustable / sit-stand desk** | Height-adjustable (manual crank or electric motor). | Combines sitting + standing; ergonomic flexibility. | Higher cost, more moving parts, needs power. |
| **Corner / L-shaped desk** | Wraps around a corner for more surface area. | Large workspace, good for multi-monitor. | Large footprint; corner ergonomics tricky. |
| **Treadmill / active desk** | Standing desk paired with a treadmill. | Promotes activity. | Expensive, noisy, distracting. |
| **Wall-mounted / floating desk** | Desk surface fixed to a wall. | Space-saving, clean look. | Limited weight capacity, no height adjust. |

## 2. Standard Dimensions & Ergonomic Guidelines

### Standard dimensions
- **Depth**: 24–30 in (61–76 cm) — 30 in recommended for monitors.
- **Width**: 48–72 in (122–183 cm) — 60 in typical for a single workstation.
- **Sitting height**: 28–30 in (71–76 cm) from floor to top of surface.
- **Standing height**: 38–42 in (97–107 cm) from floor to top of surface.
- **Leg clearance**: at least 24 in (61 cm) wide, 26 in (66 cm) high, 20 in (51 cm) deep.
- **Thickness**: 1–1.5 in (2.5–3.8 cm) typical desktop.

### Ergonomic guidelines (ANSI/HFES 100, OSHA)
- **Elbow height**: desk surface should be at or slightly below seated elbow height.
- **Forearms**: parallel to floor, elbows at 90–110°.
- **Wrists**: neutral (straight), not bent up/down.
- **Monitor**: top of screen at or slightly below eye level, ~20–30 in (51–76 cm) away.
- **Feet**: flat on floor or on a footrest; thighs parallel to floor.
- **Knees**: ~90° bend, clear of the desk underside.
- **Reach**: frequently used items within a comfortable arm's reach (no over-reaching).
- **Sit-to-stand cadence**: alternate every 30–60 minutes.

## 3. Materials & Structural Considerations

### Materials
| Material | Properties | Use |
|----------|-----------|-----|
| **Solid wood** | Durable, premium, heavy. | High-end desktops. |
| **Plywood / MDF** | Cheap, stable, easy to finish. | Common desktops. |
| **Particleboard** | Lowest cost, low durability. | Budget desktops. |
| **Steel** | Strong, rigid, high load. | Frames, legs, brackets. |
| **Aluminum** | Light, corrosion-resistant. | Adjustable legs, frames. |
| **Glass** | Aesthetic, easy to clean. | Desktops (needs tempered glass). |
| **Laminate / veneer** | Protective surface finish. | Over MDF/particleboard. |

### Structural considerations
- **Load capacity**: support 100–200 lb (45–90 kg) typical; verify for monitors + equipment.
- **Stability**: wide base, low center of gravity; avoid wobble at standing height.
- **Frame rigidity**: cross-bracing and gussets prevent racking/twisting.
- **Height mechanism**: electric (linear actuator) vs manual (crank/gas spring); electric needs motor + control.
- **Weight distribution**: legs at corners; center support for wide spans to prevent sag.
- **Surface finish**: moisture/scratch resistance; edge banding for MDF/particleboard.
- **Assembly**: fasteners, leveling feet, cable management channels.
- **Safety**: rounded edges, no pinch points in adjustable mechanisms, stable under load.

## 6. Features to Consider
- Height presets / memory positions.
- Cable management (grommets, trays).
- Monitor arms / risers.
- Keyboard tray.
- Drawers / storage.
- Anti-collision / obstacle detection on motorized desks.
- Locking casters or leveling feet.

## Summary for Implementation
- Support **sitting**, **standing**, and **adjustable** modes.
- Default surface: 60 in wide × 30 in deep; sitting 29 in, standing 40 in.
- Use **steel legs** + **MDF/wood top** for cost/strength balance.
- Enforce ergonomic defaults: elbow-height surface, monitor at eye level, 90° joints.
- Include stability, load, and safety constraints in the design model.