# Desk System Architecture

Architecture for the desk system, defining components, modules, interfaces,
data models, and APIs. Built on the research in `docs/desk-research.md`.

## 1. High-Level Architecture Diagram

```
+--------------------------------------------------------------+
|                        UI Layer (src/ui)                      |
|  Control Panel  |  Status Display  |  Preset Manager          |
+----------------------------+---------------------------------+
                             |  commands / events
+----------------------------v---------------------------------+
|                     Application Layer (src/core)             |
|  DeskController  |  HeightManager  |  SurfaceManager          |
|  StabilityManager|  ErgonomicsEngine                         |
+----------------------------+---------------------------------+
                             |  domain calls
+----------------------------v---------------------------------+
|                      Domain Layer (src/domain)               |
|  Desk  Height  Surface  Stability  Preset  Material           |
+----------------------------+---------------------------------+
                             |  persistence
+----------------------------v---------------------------------+
|                   Infrastructure Layer (src/infra)           |
|  MotorDriver  SensorAdapter  PersistenceStore  EventBus       |
+--------------------------------------------------------------+
```

## 2. Component Responsibilities & Interactions

### Presentation Layer (`src/ui`)
- **ControlPanel**: renders height up/down buttons, mode toggle (sit/stand/adjustable).
- **StatusDisplay**: shows current height, mode, load, and stability status.
- **SettingsManager**: manages presets, ergonomic defaults, and preferences.
- Interacts with the Application layer by dispatching commands and subscribing to events.

### Application Layer (`src/core`)
- **DeskController**: orchestrates user commands into domain operations; the public facade.
- **HeightRequest**: validates and queues height-change requests (with limits + anti-collision).
- **Ergonomics**: computes recommended heights from user body metrics and enforces defaults.
- **StabilityManager**: monitors load distribution and wobble; flags unsafe states.
- Emits typed events for every state change (see `src/events.ts`).

### Domain Layer (`src/domain`)
- **Desk**: aggregate root; owns Height, Surface, Stability, and Presets.
- **Height**: value object with min/max range and current/target values.
- **Surface**: dimensions (width/depth/thickness) and material.
- **Stability**: load capacity, base width, center-of-gravity constraints.
- **Preset**: named height configuration (e.g., "sitting", "standing").
- **Material**: material properties (strength, weight, cost).

### Infrastructure Layer (`src/infra`)
- **MotorDriver**: interface to the physical height-adjustment motor.
- **SensorAdapter**: reads load/position sensors.
- **PresetStore**: persists presets to `.mochi/`.
- **ConfigStore**: persists user preferences and ergonomic settings.

## 3. Data Models & APIs

### Domain types (TypeScript)

```ts
type DeskMode = "sitting" | "standing" | "adjustable";

interface Height {
  current: number;   // cm
  target: number;    // cm
  min: number;       // cm
  max: number;       // cm
}

interface Surface {
  width: number;     // cm
  depth: number;     // cm
  thickness: number; // cm
  material: Material;
}

interface Material {
  id: string;
  name: string;
  weightKg: number;
  loadCapacityKg: number;
  cost: number;
}

interface Stability {
  loadCapacityKg: number;
  stable: boolean;
  wobble: number;    // 0..1
}

interface Preset {
  id: string;
  name: string;      // "sitting" | "standing" | custom
  heightCm: number;
}

interface DeskState {
  mode: DeskMode;
  height: Height;
  surface: Surface;
  stability: Stability;
  presets: Preset[];
}
```

### Public API (DeskController facade)

```ts
class DeskController {
  getState(): DeskState;
  setHeight(cm: number): Promise<DeskState>;
  setMode(mode: DeskMode): Promise<DeskState>;
  applyPreset(id: string): Promise<DeskState>;
  savePreset(name: string, heightCm: number): Preset;
  setErgonomics(metrics: UserMetrics): void;
  on(event: DeskEvent, handler: (s: DeskState) => void): void;
}
```

### Events (`src/events.ts`)
- `height.changed` — emitted when height changes.
- `mode.changed` — emitted when mode changes.
- `stability.warning` — emitted when stability degrades.
- `preset.applied` — emitted when a preset is applied.
- `error` — emitted on motor/sensor failures.

## 4. Design Decisions
- **Layered architecture** keeps UI independent from core logic and hardware.
- **Event-driven** state changes (per project convention) for testability and decoupling.
- **Domain model** is pure TypeScript with no I/O, enabling unit testing.
- **Infrastructure adapters** isolate hardware so the core runs in tests without a motor.
- Persistence of presets/config to `.mochi/` per project convention.

## 5. Defaults (from research)
- Surface: 152 cm wide × 76 cm deep × 3 cm thick.
- Sitting height: 74 cm; standing height: 102 cm.
- Height range: 60–125 cm.
- Load capacity: 100 kg.
- Materials: steel legs + MDF/wood top.