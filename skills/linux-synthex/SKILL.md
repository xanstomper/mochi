---
name: linux-synthex
description: Linux Synthex advanced architecture
---

# Linux Synthex — Architecture Overview

> **Document Version:** 1.0  
> **Classification:** Architecture Reference  
> **Project:** Linux Synthex  
> **Last Updated:** July 2026

---

## Table of Contents

1. [Project Philosophy and Design Principles](#1-project-philosophy-and-design-principles)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Component Stack](#3-component-stack)
4. [Build System Architecture](#4-build-system-architecture)
5. [Repository Structure](#5-repository-structure)
6. [Security Model Overview](#6-security-model-overview)
7. [Desktop Environment Architecture](#7-desktop-environment-architecture)
8. [Performance Architecture](#8-performance-architecture)
9. [Gaming Stack Architecture](#9-gaming-stack-architecture)
10. [AI Integration Architecture](#10-ai-integration-architecture)
11. [Packaging and Distribution Model](#11-packaging-and-distribution-model)
12. [Update and Upgrade Strategy](#12-update-and-upgrade-strategy)
13. [Backup and Rollback Architecture](#13-backup-and-rollback-architecture)
14. [Release Engineering Approach](#14-release-engineering-approach)

---

## 1. Project Philosophy and Design Principles

### 1.1 Mission Statement

Linux Synthex is designed to be the **ultimate desktop operating system** — a distribution that refuses to compromise. It bridges the traditionally opposing worlds of Fedora's enterprise-grade stability, Arch Linux's bleeding-edge customizability, and gaming-first performance optimisation, all wrapped in a user experience that aspires to macOS-level polish and coherence.

### 1.2 Core Design Tenets

| Principle | Description |
|---|---|
| **Convergence, Not Compromise** | Every architectural decision must serve multiple constituencies simultaneously — stability for professionals, freedom for power users, performance for gamers, security for enterprises. |
| **Desktop-First, Always** | Unlike server-centric distributions, every component from kernel configuration to package selection is optimised for interactive desktop use. No component is included solely for server workloads. |
| **Sane Defaults, Infinite Tailoring** | Out of the box, every setting produces a polished, performant experience. Every default is also overrideable — no user is locked out of customisation by design. |
| **Wayland-Only, No X11 Backstop** | The project has made a definitive architectural commitment to Wayland as the sole display protocol. There is no X11 fallback, eliminating the entire class of X11-specific security, performance, and maintenance burdens. |
| **Immutable-Core / Mutable-Userland** | The base system is cryptographically verified and updated atomically. User modifications, packages, and configuration live on separate, fully writable volumes. |
| **Fresh, Never Stale** | Rolling-forward release model with continuous integration. No package remains unpatched for more than 7 days for critical CVEs. |

### 1.3 Target Audience Segments

- **Desktop Professionals** — Developers, designers, and knowledge workers who need a reliable daily driver.
- **Gamers** — Users demanding native-competitive performance, low-latency audio/video stacks, and Proton/Wine integration.
- **Enterprise Workstations** — Organisations requiring SELinux, full disk encryption, audit trails, and compliance-ready configurations.
- **Linux Enthusiasts** — Power users who want Arch-like customisability without the maintenance burden of a rolling-release DIY distribution.

---

## 2. System Architecture Overview

### 2.1 High-Level Layered Diagram

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                        USER APPLICATIONS                            │
 │  Flatpaks  │  RPM Native  │  Distrobox/Toolbox  │  Containers      │
 ├─────────────────────────────────────────────────────────────────────┤
 │                     DESKTOP ENVIRONMENTS                            │
 │  KDE Plasma 6 (Primary)  │  Hyprland (Secondary)  │  GNOME (Tert.)  │
 │  + Synthex Branding Suite  │  + Synthex Dotfiles      │  + Extensions   │
 ├─────────────────────────────────────────────────────────────────────┤
 │                       DISPLAY SERVER                                 │
 │                  Wayland Compositor (KWin / Hyprland / Mutter)       │
 │                    + libdisplay-info + libliftoff                    │
 ├─────────────────────────────────────────────────────────────────────┤
 │                        USERSPACE SERVICES                            │
 │  systemd  │  DNF5  │  flatpak  │  PipeWire  │  Power Profiles       │
 │  fwupd   │  colord │  accounts-daemon  │  udisks2  │  bolt          │
 ├─────────────────────────────────────────────────────────────────────┤
 │                     SYSTEM LAYER                                     │
 │  GNU C Library (glibc)  │  LLVM/Clang Toolchain  │  Rust Toolchain   │
 │  OpenSSL  │  systemd-boot  │  SELinux  │  BTRFS  │  stratis          │
 ├─────────────────────────────────────────────────────────────────────┤
 │                         LINUX KERNEL                                  │
 │  BORE + EEVDF Scheduler  │  fsckless BTRFS  │  bcachefs (opt.)      │
 │  Zen Kernel Tuning       │  AMD / Intel / NVIDIA  │  NTFS3            │
 │  Preempt Full / NO_HZ    │  Anbox / Waydroid  │  KVM               │
 ├─────────────────────────────────────────────────────────────────────┤
 │                       BOOT FIRMWARE                                   │
 │          UEFI  │  systemd-boot  │  Secure Boot  │  TPM 2.0           │
 └─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Storage Layout

```
┌──────────────────────────────┬───────────────────┬────────────────────┐
│     Partition / Volume       │   Filesystem      │   Mount Point      │
├──────────────────────────────┼───────────────────┼────────────────────┤
│ EFI System Partition         │ FAT32             │ /boot/efi          │
│ Boot Partition               │ BTRFS (no COW)    │ /boot              │
│ Root Volume - @core          │ BTRFS (Zstd:3)    │ /usr               │
│ Root Volume - @state         │ BTRFS (Zstd:1)    │ /etc               │
│ Root Volume - @var           │ BTRFS (Zstd:3)    │ /var               │
│ Data Volume                  │ BTRFS (Zstd:1)    │ /home              │
│ Snapshots Volume             │ BTRFS             │ /.snapshots        │
│ Flatpak Data                 │ BTRFS (Zstd:1)    │ /var/lib/flatpak   │
│ Swap (optional)              │ Swap or zram      │ —                  │
└──────────────────────────────┴───────────────────┴────────────────────┘
```

This subvolume layout enables:
- **Atomic rollbacks** of `@core` without touching user data.
- **Independent snapshot policies** for system state vs. user data.
- **Efficient replication** and **offline deduplication** via BTRFS send/receive.

### 2.3 Boot Flow

```
UEFI Firmware → Secure Boot Verification
    → systemd-boot (Type #1 boot loader)
        → UKI (Unified Kernel Image) — signed with sbctl
            → initramfs (dracut) — decrypt LUKS2 if FDE
                → switch_root to BTRFS @core subvolume
                    → systemd as PID 1
                        → systemd-udev → hardware detection
                        → systemd-tmpfiles → volatile state setup
                        → systemd-sysusers → user database
                        → NetworkManager → connectivity
                        → SELinux policy load
                        → display-manager.service → greetd / SDDM
                            → Wayland compositor → user session
```

All UKIs are built with **systemd-stub** and embed both the kernel and initramfs, signed as a single EFI binary. This prevents initramfs tampering and enables measured boot with TPM 2.0 PCR registrations.

---

## 3. Component Stack

### 3.1 Kernel Layer

| Component | Implementation | Rationale |
|---|---|---|
| **Scheduler** | BORE (Burst-Oriented Response Enhancer) + EEVDF | BORE reduces latency for interactive/foreground tasks; EEVDF provides fair scheduling for background workloads. Combined, they deliver desktop responsiveness without starving batch processes. |
| **Preemption Model** | Full Preempt (PREEMPT_FULL) / Voluntary (configurable) | Full preempt for gaming/low-latency audio; voluntary for battery-optimised mobile workloads. |
| **Timer** | NO_HZ_FULL (adaptive tick) | Reduces unnecessary timer interrupts on idle CPUs, improving power efficiency. |
| **I/O Scheduler** | io_uring + BFQ (rotational) / none (NVMe) | io_uring for modern async I/O; BFQ for desktop interactivity on slower storage; no-op for NVMe. |
| **Filesystem** | BTRFS (primary), bcachefs (opt-in) | BTRFS provides snapshots, compression, checksums, and subvolumes. bcachefs available for users needing COW + RAID without BTRFS RAID56 caveats. |
| **NTFS** | NTFS3 kernel driver (Paragon) | Native, performant NTFS read/write without FUSE overhead. |
| **Containerisation** | KVM + LXC + userfaultfd | KVM for full virtualisation; LXC lightweight system containers; userfaultfd for live migration. |
| **Android Shim** | Waydroid (Anbox as fallback) | Enables Android app runtime on Linux via LXC + Wayland. |

### 3.2 System Libraries

| Component | Version / Toolchain | Notes |
|---|---|---|
| **C Library** | glibc 2.40+ | Built with `--enable-fortify-source=3` and full RELRO. |
| **Compiler Runtime** | LLVM/Clang 19 (default), GCC 14 (fallback) | Clang is the default system compiler; GCC maintained for kernel builds and ABI compatibility. |
| **Rust Toolchain** | rustc 1.80+, nightly for select packages | Used for core system components (systemd, kernel drivers, Wayland tools). |
| **Crypto** | OpenSSL 3.3 / libsodium 1.0.19 | OpenSSL for TLS/signing; libsodium for modern AEAD and password hashing. |
| **Init System** | systemd 257+ | Full systemd feature set including sysext, portable services, and homed. |
| **Boot Loader** | systemd-boot (sd-boot) | UEFI-only, no GRUB. Supports UKI, Secure Boot, TPM measured boot. |
| **Hardware DB** | udev-hwdb + libfprint + fwupd | Firmware updates via LVFS; fingerprint support via libfprint. |

### 3.3 Display and Graphics

| Component | Implementation | Notes |
|---|---|---|
| **Display Protocol** | Wayland only | X11 removed from repositories. No XWayland rootless mode — XWayland runs in rootful mode for legacy applications only. |
| **Compositors** | KWin (Plasma), Hyprland, Mutter (GNOME) | Three compositors, one per supported desktop environment. |
| **DRM** | DRM native — atomic modesetting | Direct Rendering Manager with atomic page-flip, HDR, VRR. |
| **HDR** | Color management via libcolorhug + colord + ICC profiles | HDR10 and HLG support through KWin and Mutter HDR pipelines. |
| **GPU Drivers** | AMD (amdgpu, RADV), Intel (ANV, iris), NVIDIA (nvidia-open) | Mesa mainline for AMD/Intel; nvidia-open (GSP) for Turing+ NVIDIA. Nouveau not shipped. |
| **Vulkan** | Vulkan 1.3 + VK_KHR_display + VK_EXT_hdr_metadata | Full Vulkan stack with WSI for Wayland. |
| **Audio** | PipeWire + WirePlumber + liblc3 | Pro-audio-grade JACK replacement; LDAC/LC3 codec support for Bluetooth LE Audio. |

### 3.4 Desktop Environments

| Desktop | Status | Default Components |
|---|---|---|
| **KDE Plasma 6** | Primary (flagship) | KWin Wayland, Plasma Desktop, Dolphin, Konsole, Krunner, Discover (with Flatpak + RPM backend), Synthex-customised Breeze themes. |
| **Hyprland** | Secondary | Hyprland compositor + Synthex dotfiles, waybar, rofi-wayland, dunst, swaylock-effects. |
| **GNOME 47+** | Tertiary | Mutter Wayland, GNOME Shell, Nautilus, GNOME Console, Synthex extension pack. |

### 3.5 Application Runtimes

| Runtime | Role | Scope |
|---|---|---|
| **RPM Native** | Base system packages | Kernel, libraries, DE components, core utilities. |
| **Flatpak** | Sandboxed desktop apps | Browsers, media players, IDEs, communication tools. Default runtime: Freedesktop 24.08+. |
| **Distrobox/Toolbox** | Developer containers | Immutable containers for dev toolchains (SDKs, compilers, databases). |
| **Podman** | OCI containers | For users needing full container orchestration or Docker-compatible workflows. |

---

## 4. Build System Architecture

### 4.1 Overview

The Linux Synthex build system is a **multi-stage, reproducible, containerised pipeline** built on top of Fedora's `fedpkg` / `mock` infrastructure, extended with Synthex-specific build tooling.

```
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │  SRPM Build  │ → │  Mock Chroot │ → │  Sign & Tag  │ → │  Repo Publish│
 │ (spec + src) │    │ (bootstrap)  │    │ (RPM-GPG)    │    │ (createrepo) │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
         │                  │                    │                    │
         │                  │                    │                    │
    ┌────┴────┐       ┌────┴────┐          ┌────┴────┐         ┌────┴────┐
    │ koji    │       │ mock    │          │ sign    │         │ nginx /  │
    │ build   │       │ --rebuild│         │ --gpg   │         │ s3      │
    └─────────┘       └─────────┘          └─────────┘         └─────────┘
```

### 4.2 Build Toolchain

| Tool | Purpose |
|---|---|
| **koji** | Distributed build system, Fedora-compatible. Schedules builds across build farm workers. |
| **mock** | Chroot-based build isolation. Every build runs in a clean, disposable chroot. |
| **rpmbuild** | RPM package builder. Processes `.spec` files into binary RPMs. |
| **rpmautospec** | Automatic `%changelog` generation from Git history. |
| **createrepo_c** | Generates YUM/DNF repository metadata. |
| **signing-server** | Remote signing service for RPM and container images. Keys never touch the builder. |

### 4.3 Reproducibility Guarantee

Every build is:
- **Source-verified**: `%_sourcedir` is pinned to a Git commit hash. No unversioned patches.
- **Timeless**: Build timestamps are clamped to the commit timestamp.
- **Filesystem-ordered**: Build directories are iterated in deterministic order via `rsync` ordering patches.
- **Toolchain-pinned**: Compiler, linker, and build tools are version-pinned per release cycle in a `build-lockfile.json`.

A `.buildinfo` file is produced per package containing all source hashes, build dependency trees, and environment variables — compliant with the Reproducible Builds standard.

### 4.4 Build Farm Architecture

The build farm is a Kubernetes-native cluster running on Fedora CoreOS worker nodes:

```
 ┌─────────────────────────────────────────────────────┐
 │                    Koji Hub                         │
 │  (scheduler + DB + task queue)                      │
 └────┬───────┬───────┬───────┬───────┬───────┬───────┘
      │       │       │       │       │       │
  ┌───┴───┐ ┌─┴───┐ ┌─┴───┐ ┌─┴───┐ ┌─┴───┐ ┌─┴───┐
  │ Builder│ │Builder│ │Builder│ │Builder│ │Builder│ │Builder│
  │ x86_64 │ │x86_64 │ │x86_64 │ │x86_64 │ │ aarch │ │ aarch │
  │   v1   │ │   v2  │ │   v3  │ │   v4  │ │  64   │ │  64   │
  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘ └───────┘
```

- Workers pull build tasks from Koji Hub via AMQP (RabbitMQ).
- Each worker runs `mock` in a `buildah` container for nested isolation.
- Artifacts are pushed to a staging RPM repository on S3-compatible object storage.
- Signing is performed as a separate step: the unsigned RPM never touches the same host as the signing key.

### 4.5 CI/CD Integration

```yaml
# .forgejo/workflows/build.yml (conceptual)
stages:
  - lint:          # rpmlint on spec files
  - build:         # koji build --scratch
  - test:          # install into test VM, run smoke tests
  - sign:          # signing-server sign <rpm>
  - publish:       # createrepo_c --update && s3 sync
  - livepush:      # DNF5 ref-update on staging repo
```

Every commit to the `rawhide` branch triggers a full build pipeline. The `stable` branch requires maintainer Sign-Off (SOB) on top of CI green.

---

## 5. Repository Structure

### 5.1 Top-Level Overview

```
linux-synthex/
├── architecture/          # Architecture documentation (this document)
├── branding/              # Synthex logos, wallpapers, sounds, Plymouth themes
├── build/                 # Build system config (mock configs, Koji configs, signing)
├── config/                # System configuration profiles (kernel, sysctl, DNF)
├── desktop-environments/  # DE-specific customisations
│   ├── plasma/            # Synthex Plasma theme, KWin rules, KCM modules
│   ├── hyprland/          # Synthex Hyprland dotfiles, waybar configs
│   └── gnome/             # Synthex GNOME extensions, gsettings presets
├── docs/                  # User-facing documentation
├── installer/             # Calamares modules and branding
├── kernel/                # Kernel packaging (spec, config, patches)
├── packages/              # RPM package definitions (spec files)
│   ├── core/              # Mandatory system packages
│   ├── extra/             # Repository-shipped packages
│   ├── synthex/             # Synthex-specific tools and utilities
│   └── gaming/            # Gaming stack packages
├── scripts/               # CI/CD scripts, release tooling, migration helpers
├── security/              # SELinux policies, audit rules, hardening configs
├── tests/                 # Integration tests, upgrade tests, security scans
└── tools/                 # Custom tooling (synthex-cli, synthex-config, synthex-builder)
```

### 5.2 Package Repository Hierarchy

```
synthex-repo/
├── fedora-rawhide/        # Upstream Fedora packages (tracked, not forked)
├── synthex-core/            # Synthex-maintained core packages (kernel, toolchain, glibc)
├── synthex-desktop/         # Desktop environment packages (Plasma, Hyprland, GNOME custom)
├── synthex-gaming/          # Gaming stack (Proton, MangoHud, Gamescope, Lutris)
├── synthex-ai/              # AI/ML toolchain (ROCm, CUDA wrappers, llama.cpp, etc.)
├── synthex-multimedia/      # PipeWire, codecs, DAW tools, audio plugins
├── synthex-hardware/        # Driver packages, firmware, hardware enablement
├── synthex-universe/        # Community-maintained packages (pre-submission queue)
└── synthex-experimental/    # Preview packages for next release cycle
```

### 5.3 Branching Strategy

```
rawhide          → Fast-moving development branch (Fedora Rawhide rebase)
synthex-XY         → Stable release branches (e.g., synthex-25, synthex-26)
synthex-staging    → Pre-release integration branch
synthex-security   → Emergency security patch branch (fast-track to stable)
```

- **rawhide** rebases to the latest Fedora Rawhide every 2–4 weeks.
- **synthex-XY** branches are cut from rawhide at release freeze.
- Security patches land in `synthex-security` first, then merged to all active branches.

---

## 6. Security Model Overview

### 6.1 Threat Model

Linux Synthex defends against the following threat categories, ranked by priority:

| Priority | Threat | Mitigation |
|---|---|---|
| P0 | Remote code execution on base system | SELinux enforcing, verified UKI, kernel lockdown, signed packages |
| P1 | Malicious Flatpak / container breakout | SELinux + bubblewrap + user namespace restrictions |
| P2 | Physical access / cold boot | LUKS2 + TPM2 (measured boot) + FIDO2/PIN |
| P3 | Package supply chain attack | Signed commits (GPG), signed RPMs, reproducible builds, in-toto attestations |
| P4 | Data exfiltration via compromised app | Flatpak sandbox, SELinux domain transitions, Firewalld zones |
| P5 | Side-channel / speculative execution | Kernel mitigations (retbleed, spectre_v2, etc.) enabled by default |

### 6.2 SELinux Policy Architecture

```
┌──────────────────────────────────────────────────┐
│                SELinux Policy                     │
│  Targeted policy (default enforcing)              │
│  ├── synthex_base.pp    — Core system types        │
│  ├── synthex_desktop.pp — Desktop app domains      │
│  ├── synthex_gaming.pp  — Gaming runtime domains   │
│  ├── synthex_flatpak.pp — Flatpak interface        │
│  └── synthex_containers.pp — Container boundaries  │
├──────────────────────────────────────────────────┤
│  Booleans (selected examples):                    │
│  synthex_allow_user_exec   → allow ~/bin execution │
│  synthex_gaming_full_hw    → full GPU/input access  │
│  synthex_dev_mode          → relaxed for dev work   │
└──────────────────────────────────────────────────┘
```

- Enforced in **enforcing mode** by default. Permissive mode generates audit logs but is not shipped as a default.
- `auditd` + `setroubleshoot` provide actionable SELinux denial messages to users.
- `synthex-dev-mode` boolean exists but logs a warning to `/var/log/secure` when active.

### 6.3 Cryptography and Signing

| Artifact | Signature Type | Key Storage |
|---|---|---|
| RPM packages | GPG (RSA 4096) | Hardware security module (YubiHSM / Nitrokey HSM) |
| UKI images | PE signature (sbctl + Microsoft KEK) | TPM-backed machine key for local builds; HSM for release |
| Git commits | GPG or SSH (Ed25519) | Developer YubiKey / SSH CA |
| Container images | Sigstore (cosign) | OIDC-based keyless signing |
| Repo metadata | GPG (RSA 4096) | Same HSM as RPM keys |
| ISO images | GPG + SHA-256SUMS | Release manager key (offline, multi-party) |

### 6.4 Kernel Hardening

All Synthex kernels are built with:

- `CONFIG_SECURITY_SELINUX=y`
- `CONFIG_SECURITY_LOCKDOWN_LSM=y` (integrity mode)
- `CONFIG_STATIC_USERMODEHELPER=y`
- `CONFIG_SYN_COOKIES=y`
- `CONFIG_DEBUG_CREDENTIALS=y`
- `CONFIG_RANDOMIZE_KSTACK_OFFSET=y`
- `CONFIG_GCC_PLUGINS=y` (including `LATENT_ENTROPY`, `STRUCTLEAK`, `STACKLEAK`)
- `CONFIG_IOMMU_DEFAULT_DMA_STRICT=y`
- `CONFIG_SECURITY_BPF=y`
- `CONFIG_HARDENED_USERCOPY=y`
- `CONFIG_SLAB_FREELIST_RANDOM=y`
- `CONFIG_SLAB_FREELIST_HARDENED=y`
- `CONFIG_MITIGATION_*` — all speculative execution mitigations enabled

### 6.5 User Namespace Restrictions

By default, `kernel.unprivileged_userns_clone = 0`. This prevents a large class of container-escape and privilege-escalation attacks. Users who need unprivileged user namespaces (e.g., for Podman rootless mode) opt in via a sysctl drop-in:

```bash
# /etc/sysctl.d/90-synthex-user-ns.conf
kernel.unprivileged_userns_clone = 1
```

---

## 7. Desktop Environment Architecture

### 7.1 KDE Plasma 6 — Flagship Desktop

Plasma 6 is the primary, best-supported desktop environment. Synthex ships a deeply customised Plasma experience.

#### 7.1.1 Synthex Plasma Theme Suite

| Component | Customisation |
|---|---|
| **Plasma Theme** | `synthex-breeze` — based on Breeze but with Synthex colour palette (deep teal, warm grey accents, Synthex gradient accents) |
| **Colour Scheme** | `SynthexDark` and `SynthexLight` — WCAG AA-compliant contrast ratios |
| **Icon Theme** | `synthex-icons` — Tela-circle base with Synthex-specific app icons (Synthex Welcome, Synthex Store, Synthex Settings) |
| **Cursor Theme** | `synthex-cursors` — Bibata Modern derivative, Synthex-branded |
| **KWin Window Decorations** | `synthex-decoration` — minimal titlebars with integrated app menu button |
| **SDDM Theme** | `synthex-sddm` — clean, blurred-background login with Synthex branding |
| **Plymouth Theme** | `synthex-plymouth` — animated Synthex logo with spinner and disk encryption prompt |

#### 7.1.2 Default Plasma Configuration

| Setting | Default | Rationale |
|---|---|---|
| **Panel Layout** | Bottom single panel (macOS-inspired) | Fitts's law optimisation, consistent with Synthex vision |
| **Global Menu** | Enabled (appmenu-gtk-module + applet) | Maximises vertical screen real estate |
| **Virtual Desktops** | 4 (2×2 grid) | Discoverable workspace model for new users |
| **Window Tiling** | KWin tiling script enabled | Better-than-basic tiling without going full WM |
| **Overview Effect** | Meta+Tab | Mission Control analogue for spatial navigation |
| **Hot Corners** | TL: Overview, TR: Desktop Grid, BR: Show Desktop | Muscle-memory compatibility with macOS/pop-shell |
| **Wake-on-LAN** | Disabled | Privacy and power management |
| **Baloo (File Indexing)** | Enabled, limited to `/home` | Search performance without indexing compiler caches |
| **Night Color** | Automatic (geo-IP location) | Blue light reduction, default enabled |

#### 7.1.3 KWin Rules (Synthex Preset)

- **Games / Fullscreen applications**: `Force compositor → Full screen repaint`, `Block compositing while fullscreen` = enabled
- **Steam**: `Force → Windows with no titlebar and frames`
- **Video Players (mpv, VLC)**: `Force → Allow direct scanout`
- **IDEs (VS Code, JetBrains)**: `Force → Smooth scaling`, `Block compositing = disabled`

### 7.2 Hyprland — Tiling Secondary Desktop

Hyprland is the secondary desktop, targeting power users who prefer a dynamic tiling window manager. Synthex ships a curated, cohesive Hyprland configuration.

#### 7.2.1 Synthex Hyprland Stack

```
┌──────────────────────────────────────────┐
│              Synthex Hyprland               │
├──────────────────────────────────────────┤
│  Compositor:   Hyprland (git mainline)   │
│  Bar:          waybar (synthex theme)      │
│  Launcher:     rofi-wayland (synthex theme)│
│  Notifications: dunst                    │
│  Lockscreen:   swaylock-effects          │
│  Wallpaper:    swaybg / hyprpaper        │
│  Idle:         hypridle                  │
│  Clipboard:    wl-clipboard + cliphist   │
│  Screen shot:  grim + slurp + swappy     │
│  App menu:     rofi-drun                 │
│  Auth agent:   polkit-kde-agent          │
└──────────────────────────────────────────┘
```

#### 7.2.2 Hyprland Keybindings (Synthex Default)

| Binding | Action |
|---|---|
| `SUPER` + `Q` | Launch terminal (kitty) |
| `SUPER` + `D` | Application launcher (rofi drun) |
| `SUPER` + `E` | File manager (Dolphin) |
| `SUPER` + `W` | Web browser (Firefox) |
| `SUPER` + `Arrow` | Focus window in direction |
| `SUPER` + `SHIFT` + `Arrow` | Move window in direction |
| `SUPER` + `1`–`9` | Switch workspace |
| `SUPER` + `SHIFT` + `1`–`9` | Move window to workspace |
| `SUPER` + `F` | Fullscreen toggle |
| `SUPER` + `V` | Clipboard manager (cliphist) |
| `SUPER` + `T` | Toggle floating |
| `SUPER` + `M` | Toggle monocle layout |
| `SUPER` + `SPACE` | Toggle split direction |
| `ALT` + `TAB` | Window switcher |

### 7.3 GNOME — Tertiary Desktop

GNOME is shipped as a supplementary desktop with minimal customisation to respect upstream design intent. The Synthex GNOME spin applies:

- **Synthex-branded wallpapers** and lock screen
- **Extension pack** (auto-installed): AppIndicator, Blur My Shell, GSConnect, Vitals, Dash to Dock (opt-in)
- **GSettings overlay**: Default dark mode, medium-sized text, pointer location on Ctrl
- **Console** (GNOME Console) as default terminal
- **Nautilus** with Synthex sidebar bookmarks (Downloads, Documents, Projects, Games, Flatpak apps)

---

## 8. Performance Architecture

### 8.1 CPU Scheduler: BORE + EEVDF

The Synthex kernel ships the **BORE (Burst-Oriented Response Enhancer)** scheduler patchset on top of the upstream **EEVDF (Earliest Eligible Virtual Deadline First)** scheduler.

**How it works:**

1. **EEVDF** provides the base scheduling fairness — each task receives a proportion of CPU time proportional to its weight (nice value).
2. **BORE** modifies the EEVDF's `vruntime` calculation for interactive tasks by subtracting a bonus proportional to the task's **burst ratio** (wakeup-preemption latency / total runtime).
3. Tasks that wake up frequently and run briefly (interactive I/O tasks: GUI rendering, audio threads, game engine input polling) receive a **vruntime bonus** that elevates them in the EEVDF's eligibility queue.
4. CPU-bound background tasks (compilation, video encoding) accumulate vruntime normally and do not receive BORE bonuses.

**User configuration:**

```bash
# /sys/kernel/debug/sched/bore_base_scale     # Default: 8 (0-255, higher = stronger burst preference)
# /sys/kernel/debug/sched/bore_big_scale      # Bonus for >1ms wakeup gaps
```

The default values are tuned for a **low-latency desktop workload mix** — games + browser + IDE + audio production.

### 8.2 Memory Management

| Tuning | Value | Purpose |
|---|---|---|
| `vm.swappiness` | 10 | Avoid swapping unless under extreme memory pressure. |
| `vm.vfs_cache_pressure` | 50 | Retain dentry/inode caches longer for faster repeated filesystem access. |
| `vm.dirty_ratio` | 20 | Batch writes to reduce fragmentation. |
| `vm.dirty_background_ratio` | 5 | Start background writeback early. |
| `vm.dirty_expire_centisecs` | 3000 | 30 seconds max dirty page age. |
| `vm.compaction_proactiveness` | 50 | Moderate proactive compaction to reduce allocation latency. |
| `kernel.numa_balancing` | 0 (disabled) | Avoid NUMA balancing overhead on desktop/client hardware. |
| `transparent_hugepage` | `madvise` | Only use THP on explicitly `MADV_HUGEPAGE` allocations (prevents khugepaged overhead on desktop workloads). |

### 8.3 Storage Performance

| Feature | Default | Notes |
|---|---|---|
| **BTRFS mount options** | `noatime,compress=zstd:3,space_cache=v2,autodefrag,subvolid=0` | noatime eliminates metadata write amplification; zstd:3 balances speed vs. compression; space_cache v2 for efficient free-space tracking. |
| **BTRFS compression** | zstd:3 default, zstd:1 for `/home`, zstd:7 for `/var/log` | Heavier compression on write-once logs, lighter on frequently-read user data. |
| **Journal** | BTRFS no-journal mode (nologreplay) for `/var/cache` | Cache partitions are expendable — no need for journal overhead. |
| **I/O priority** | `ionice -c 3` (idle) for background system tasks (`updatedb`, `fwupd refresh`, `dnf makecache`) | Prevents background I/O from impacting foreground responsiveness. |
| **Trim** | `fstrim.timer` — weekly on all SSD/NVMe | Maintains sustained write performance. |

### 8.4 Graphics Performance

| Feature | Implementation |
|---|---|
| **GPU scheduling** | DRM scheduler with `fifo=1` (AMD), nvidia-scheduler (NVIDIA) |
| **Vulkan** | Mesa 24.3+ (RADV/ANV), NVIDIA 570+ proprietary |
| **DX12 → Vulkan** | VKD3D-Proton (updated monthly) |
| **DXVK** | DXVK for DirectX 9/10/11 translation |
| **Direct scanout** | KWin direct scanout for fullscreen applications |
| **VRR** | Variable Refresh Rate (FreeSync / G-Sync Compatible) — enabled by default on supported hardware |
| **Async reprojection** | Gamescope (for Steam Gaming Mode-similar experience) |
| **Fsync / NTSync** | Kernel FUTEX2 + NTSync (NT synchronization primitives) for Wine |

### 8.5 Audio Performance

| Component | Tuning |
|---|---|
| **PipeWire** | `default.clock.rate = 48000`, `default.clock.quantum = 256` (low-latency profile) |
| **WirePlumber** | Media role routing — games to dedicated audio device, comms to headset |
| **RTKit** | PipeWire and JACK clients granted `CAP_SYS_NICE`/`RLIMIT_RTPRIO` |
| **ALSA** | No resampling in kernel; `plug` plugin for rate conversion in userspace |

---

## 9. Gaming Stack Architecture

### 9.1 Overview

Linux Synthex is engineered as a **first-class gaming distribution**. The gaming stack is not an afterthought bolted onto the desktop — it is deeply integrated into the kernel scheduler, graphics pipeline, and package management.

### 9.2 Gaming Stack Layers

```
┌────────────────────────────────────────────────────────────────────┐
│                   GAME LAUNCHERS / CLIENTS                         │
│  Steam (native)  │  Lutris  │  Heroic Games Launcher  │  Bottles  │
├────────────────────────────────────────────────────────────────────┤
│                    COMPATIBILITY LAYERS                             │
│  Proton GE / Valve Proton  │  VKD3D-Proton  │  DXVK  │  Wine-GE   │
│  Fsync / NTSync  │  esync  │  vkmultigpu  │  gamemode             │
├────────────────────────────────────────────────────────────────────┤
│                  PERFORMANCE TOOLING                               │
│  MangoHud  │  GOverlay  │  Gamescope  │  vkBasalt  │  ReplaySorcery│
│  Gamemode (lib)  │  mangohud (lib)  │  DRI_PRIME                 │
├────────────────────────────────────────────────────────────────────┤
│                DRIVER / RUNTIME LAYER                               │
│  Mesa (RADV/ANV)  │  nvidia-open  │  Vulkan-Loader  │  libglvnd   │
│  APU/iGPU switching  │  VA-API / NVENC  │  libva               │
├────────────────────────────────────────────────────────────────────┤
│                   SYSTEM LAYER (from §8)                           │
│  BORE+EEVDF Scheduler  │  Gamemode daemon  │  RTKit  │  irqbalance │
│  PipeWire low-latency  │  DRM VRR  │  memlock ulimit              │
└────────────────────────────────────────────────────────────────────┘
```

### 9.3 Gamemode Integration

The Synthex gaming stack is built around **Feral Interactive's Gamemode**, extended with Synthex-specific optimisations:

| Optimisation | Gamemode Request | Synthex Default (idle) | Synthex Gamemode Active |
|---|---|---|---|
| CPU governor | `performance` | `schedutil` | `performance` |
| I/O scheduler | `none`/`bfq` per device | `mq-deadline` (NVMe) | `none` |
| GPU governor (AMD) | `high` | `auto` | `high` |
| Nice level | `-4` | `0` | `-4` |
| Realtime priority | `SCHED_FIFO:2` | `SCHED_OTHER:0` | `SCHED_FIFO:2` |
| memlock | unlimited | 64 KB | unlimited |
| IRQ affinity | game-pinned CPUs | default | game-pinned CPUs |
| Wifi powersave | off | on (laptops) | off |
| Transparent hugepages | `always` | `madvise` | `always` |
| SMT/HT | force-on | as-is | force-on |

All optimisations are **reverted atomically** when the game exits and Gamemode deactivates.

### 9.4 Proton Stack

| Component | Source | Update Cadence |
|---|---|---|
| **Valve Proton** | Fedora RPM (Wine upstream) | 2–4 weeks |
| **Proton GE** | Synthex Gaming repository | ~1 week after GE release |
| **VKD3D-Proton** | Synthex Gaming repository | Monthly (upstream tag) |
| **DXVK** | Synthex Gaming repository | Monthly (upstream tag) |
| **Wine GE** | Synthex Gaming repository | ~1 week after GE release |
| **Wine (vanilla)** | Fedora RPM | As Fedora updates |

### 9.5 Gamescope Integration

Gamescope (Valve's micro-compositor) is fully integrated into the Synthex gaming stack:

- **Steam Integration**: Gamescope is the default compositor for Steam games when "Use Gamescope" is toggled.
- **Non-Steam Games**: Lutris and Heroic Games Launcher are pre-configured to detect and use Gamescope.
- **Hotkeys**: `Super+G` in KDE/Plasma toggles Gamescope session on the focused game window.
- **HDR Passthrough**: Gamescope captures HDR metadata from games and passes it through KWin's HDR pipeline to the display.

### 9.6 Multi-GPU Support

| Configuration | Mechanism | Notes |
|---|---|---|
| **iGPU + dGPU (PRIME)** | `DRI_PRIME=1` via Lutris/Heroic profile | Automatically configured by Synthex GPU detection script on first boot |
| **NVIDIA Optimus** | nvidia-open + modesetting | Wayland native; no Bumblebee required |
| **Multi-dGPU desktop** | vkmultigpu | Experimental Vulkan device groups for SLI-like frame distribution |

### 9.7 Anti-Cheat Compatibility

Synthex ships compatibility utilities for kernel-level anti-cheat systems:

- **EAC (Easy Anti-Cheat)** — Proton EAC runtime installed by default
- **BattlEye** — Proton BattlEye runtime installed by default
- **Ricochet (CoD)** — kernel module loaded on-demand; black-box tested per release
- **Vanguard (Valorant)** — Not supported. The Synthex philosophy is to support open gaming ecosystems; kernel-level rootkits are antithetical to the security model.

---

## 10. AI Integration Architecture

### 10.1 Overview

Linux Synthex is designed as a **local-first AI workstation**. The AI integration architecture prioritises user privacy, local inference, and hardware acceleration over cloud-dependent services. Every AI feature in Synthex can function entirely offline.

### 10.2 AI Stack

```
┌──────────────────────────────────────────────────────────────────┐
│                   AI APPLICATIONS                                 │
│  Hermes Agent (system assistant)  │  Ollama  │  LM Studio        │
│  Local RAG (LlamaIndex / LangChain)  │  Whisper (STT)            │
├──────────────────────────────────────────────────────────────────┤
│                   INFERENCE FRAMEWORKS                            │
│  llama.cpp  │  MLX (Apple Silicon)  │  ONNX Runtime  │  PyTorch  │
│  TensorFlow Lite  │  OpenVINO  │  NVIDIA TensorRT (opt.)         │
├──────────────────────────────────────────────────────────────────┤
│                   HARDWARE ACCELERATION                           │
│  ROCm 6.x (AMD GPU)  │  CUDA 12.x (NVIDIA)  │  Vulkan Compute    │
│  Intel OpenVINO / XMX  │  Apple Metal  │  SYCL                    │
│  IPEX-LLM (Intel)  │  ZenDNN (AMD CPU)  │  oneDNN                │
├──────────────────────────────────────────────────────────────────┤
│                   SYSTEM AI GUARD                                 │
│  On-device Hermes Agent (HermesGPT-inference)  │  Whisper.cpp     │
│  Local embedding models  │  Local reranking models               │
└──────────────────────────────────────────────────────────────────┘
```

### 10.3 The "Hermes" System Assistant

Synthex ships a local, privacy-preserving AI assistant called **Hermes** (not to be confused with the agent framework):

| Feature | Implementation |
|---|---|
| **Default model** | NousResearch Hermes-3 8B (Q4_K_M GGUF) — ~5 GB RAM |
| **Fast model** | Llama-3.2 3B (Q4_K_M) — for low-latency responses on modest hardware |
| **Vision model** | LLaVA 7B (Q4_K_M) — for screen understanding and OCR |
| **Speech-to-text** | Whisper.cpp (base.en model) — offline, on-device |
| **Text-to-speech** | Piper TTS (low latency, local) |
| **Embeddings** | BGE-small-en-v1.5 (GGUF) — for local RAG |
| **Reranker** | BGE-reranker-v2-m3 — for improving retrieval quality |
| **Hardware** | ROCm / CUDA / Vulkan / Metal / BLAS (CPU fallback) |

**Privacy guarantee**: Hermes makes **zero network requests** for inference. All inference runs on local hardware. Model downloads occur once through the Synthex AI package manager; subsequent inference is air-gapped.

### 10.4 AI Package Management

AI models are distributed through a dedicated `synthex-ai` repository:

```bash
sudo dnf5 install synthex-ai-models-llama-3.2-3b
sudo dnf5 install synthex-ai-models-hermes-3-8b
sudo dnf5 install synthex-ai-models-bge-small-en-v15
sudo dnf5 install synthex-ai-models-whisper-base-en
```

Each model is packaged as a `.rpm` that places the GGUF file into `/usr/share/synthex-ai/models/`. Model RPMs are verified with the same GPG trust chain as system packages.

### 10.5 AI Hardware Detection

On first boot (or when a GPU driver is updated), the `synthex-ai-detect` service runs:

```bash
# Pseudocode for /usr/lib/systemd/system/synthex-ai-detect.service
Check /sys/class/drm/ for AMD GPU → install rocm-hip-runtime + rocblas
Check /sys/class/drm/ for NVIDIA GPU → install cuda-toolkit + nvidia-cuda-container
Check /sys/devices/cpu/ for Intel Arc → install intel-opencl-icd + level-zero
Default: CPU fallback (OpenBLAS / oneDNN)
```

### 10.6 AI Desktop Integration

| Feature | Integration |
|---|---|
| **Hermes Quick Access** | `Ctrl+Space` global hotkey opens inline Hermes chat overlay (Hyprland: `SUPER+SPACE`; GNOME: `Alt+Space`) |
| **Natural Language Search** | Krunner plugin for semantic file search via BGE embeddings |
| **Smart Notification Summaries** | Optional: Hermes summarises notification clusters when away from keyboard |
| **Voice Dictation** | System-wide speech-to-text via Whisper.cpp; toggleable with `Ctrl+\`` |
| **AI Shell** | `synthex-ai shell` — interactive AI shell for command generation and execution |
| **Adaptive Power Profiles** | Hermes monitors running tasks and suggests power profile changes |

---

## 11. Packaging and Distribution Model

### 11.1 Repository Architecture

Linux Synthex maintains a **three-tier repository** structure:

| Tier | Name | Contents | Update Frequency | Quality Gate |
|---|---|---|---|---|
| 1 | `synthex-core` | Kernel, toolchain, glibc, systemd, SELinux policy, bootloader | Every 2–4 weeks (rawhide rebase) + security hotfixes | Maintainer review + CI + automatic testing |
| 2 | `synthex-desktop` | Desktop environments, core applications, drivers | Continuous (rolling) | Peer review + CI |
| 3 | `synthex-extra` | Extra applications, development tools, libraries | Continuous (rolling) | CI only (+ 24h beta) |

### 11.2 RPM Signing and Distribution

```
Package Build
    ↓
Unsigned RPM  ──→  signing-server (HSM-backed)
    ↓
Signed RPM    ──→  staging S3 bucket
    ↓
createrepo_c  ──→  repomd.xml + GPG signature
    ↓
rsync / s3    ──→  production CDN (Fastly / BunnyCDN)
    ↓
dnf5 update        ←─  User's machine
```

### 11.3 Flatpak Integration

Flatpak is a **first-class citizen** in Synthex, not an add-on:

- **Discover** (KDE Plasma) ships with the Flatpak backend enabled by default.
- **Flathub** is pre-configured as the default remote.
- **Flatpak permissions** are managed via `flatseal` (pre-installed in Plasma spin).
- **Bare host Flatpak** runtime is prioritised — Flatpak apps can access system fonts, themes, and portals without bundling duplicates.

### 11.4 ISO Installation

ISO images are built using **lorax** (Fedora's image builder) + Synthex configuration overlay:

```bash
# Conceptual ISO build command:
livemedia-creator --make-iso \
    --iso-name Synthex-Plasma-2025.1-x86_64.iso \
    --ks synthex-plasma-live.ks \
    --releasever 40
```

ISOs are shipped for each desktop spin:

- `Synthex-Plasma-<version>-<arch>.iso` (flagship)
- `Synthex-Hyprland-<version>-<arch>.iso`
- `Synthex-GNOME-<version>-<arch>.iso`
- `Synthex-Minimal-<version>-<arch>.iso` (no DE, for advanced users / containers)

### 11.5 Calamares Installer

The Calamares installer is customised with Synthex-specific modules:

| Module | Synthex Customisation |
|---|---|
| **`welcome`** | Synthex branding, forum/discord links, release notes |
| **`partition`** | Default BTRFS subvolume layout; LUKS2 checkbox for FDE; option to use bcachefs |
| **`users`** | Default: user in `wheel` group; optional auto-login |
| **`summary`** | Interactive BTRFS diagram showing subvolume layout |
| **`bootloader`** | systemd-boot only; Secure Boot setup (MOK enrollment if needed) |
| **`postinstall`** | synthex-firstboot service (hardware detection, GPU driver selection, AI detect) |

---

## 12. Update and Upgrade Strategy

### 12.1 Philosophy

Linux Synthex uses a **rolling-forward hybrid model**:

- **Core system packages** (kernel, glibc, systemd, Mesa) follow Fedora Rawhide but with a **2–4 week stabilisation delay**.
- **Desktop packages** (Plasma, KDE Gear, GNOME) are updated on upstream release cycles (typically every 3–4 months).
- **Security updates** bypass the delay and are fast-tracked within **24 hours** for critical CVEs.
- **Flatpak apps** update on their own schedule via `flatpak update` (or automatically via DNF5 timer integration).

### 12.2 DNF5 Configuration

```ini
# /etc/dnf5/synthex.d/synthex-core.conf
[main]
gpgcheck=True
repo=Synthex Core
baseurl=https://repo.synthexlinux.org/core/$releasever/$basearch/

# /etc/dnf5/synthex.d/synthex-desktop.conf
[main]
gpgcheck=True
repo=Synthex Desktop
baseurl=https://repo.synthexlinux.org/desktop/$releasever/$basearch/

# /etc/dnf5/synthex.d/synthex-gaming.conf
[main]
gpgcheck=True
repo=Synthex Gaming
baseurl=https://repo.synthexlinux.org/gaming/$releasever/$basearch/
```

`$releasever` is determined by the `synthex-release` package (e.g., `40`, `41`) and enables controlled rebasing.

### 12.3 `dnf5` System Upgrade (`dnf5 distro-sync`)

When a Fedora base rebase occurs (e.g., Fedora 40 → 41):

```bash
# Automated rebase workflow:
sudo dnf5 install synthex-release-41
sudo dnf5 distro-sync --releasever=41
```

This upgrades all RPM packages to the new release's versions while preserving Synthex-specific packages through the `synthex-core` repository's version overrides.

### 12.4 Atomic Update Safety

| Update Type | Atomic? | Rollback Method |
|---|---|---|
| Flatpak updates | Yes | `flatpak list --columns=origin,ref` → `flatpak update --commit=<previous>` |
| RPM updates (normal) | No (per-package) | BTRFS snapshot rollback |
| RPM updates (critical security) | No (per-package) | BTRFS snapshot + `dnf5 history rollback` |
| Kernel/UKI updates | Yes (UKI replacement) | systemd-boot menu (previous UKI preserved) |
| `dnf5 distro-sync` rebase | No (bulk) | BTRFS snapshot taken pre-rebase |
| Flatpak Runtime updates | Yes | `flatpak list --runtime` → rollback with commit hash |

### 12.5 Automatic Update Schedule

```ini
# /etc/dnf5/automatic.conf (systemd timer)
[commands]
apply_updates = yes
download_updates = yes
[emitter]
emit_via = motd
[email]
email_from = root@synthex-desktop
email_to = user
```

- **Timer**: `dnf5-automatic.timer` runs daily at 06:00 (configurable).
- **Flatpak auto-update**: `flatpak-system-update.timer` runs weekly on Sunday at 03:00.
- **Firmware updates**: `fwupd-refresh.timer` runs daily; `fwupd-offline-update.timer` triggers on reboot if updates available.

---

## 13. Backup and Rollback Architecture

### 13.1 BTRFS Snapshot Strategy

The BTRFS subvolume layout (§2.2) enables granular, independent snapshot policies.

#### 13.1.1 Automatic Snapshots (snapper)

```xml
<!-- /etc/snapper/configs/root.xml (conceptual) -->
<config>
  <subvolume>/</subvolume>
  <timeline>yes</timeline>
  <timeline_create>hourly</timeline_create>
  <timeline_cleanup>yes</timeline_cleanup>
  <hourly_limit>24</hourly_limit>
  <daily_limit>7</daily_limit>
  <weekly_limit>4</weekly_limit>
  <monthly_limit>6</monthly_limit>
  <pre-post>yes</pre-post>
  <pre-post_command>/usr/bin/dnf5</pre-post_command>
</config>
```

| Subvolume | Snapshot Policy | Retention |
|---|---|---|
| `@core` (`/usr`) | Pre/Post DNF transactions + hourly timeline | 24h hourly, 7d daily, 4w weekly |
| `@state` (`/etc`) | Hourly timeline | 24h hourly, 7d daily |
| `@var` (`/var`) | Daily timeline | 7d daily |
| `/home` | Daily timeline (optional, user-configurable) | 7d daily |
| `/.snapshots` | — | (snapshot storage) |

#### 13.1.2 Rollback Workflow

```bash
# 1. List snapshots
sudo snapper -c root list

# 2. Create a manual pre-snapshot before a risky operation
sudo snapper -c root create -d "before mesa update"

# 3. Rollback to specific snapshot
sudo snapper -c root undochange 42..0    # revert to snapshot #42
# OR: boot into snapshot from systemd-boot snapshot menu

# 4. Verify rollback
sudo btrfs subvolume show /
```

### 13.2 systemd-boot Snapshot Menu

Synthex installs **systemd-boot snapshot hooks** (`snapper-bootctl` or equivalent) that:

1. On each snapper snapshot creation, generate a **UKI entry** for that snapshot.
2. systemd-boot presents a "Snapshots" submenu at boot.
3. Users select a snapshot, boot into it, and if satisfied, run `sudo snapper -c root undochange ...` to make it permanent.

This eliminates the need for GRUB + BTRFS snapshots integration — systemd-boot handles it natively with UKI images.

### 13.3 Off-System Backups

| Tool | Integration |
|---|---|
| **restic** | Pre-installed. Synthex-backup service runs weekly to S3/B2/rest-server |
| **borgbackup** | Available in synthex-extra. Synthex provides a `borgmatic` config template |
| **Timeshift** | GUI frontend for snapper-like functionality, available in synthex-desktop |

### 13.4 Recovery ISO

A **Synthex Recovery ISO** is available for emergency situations:

- Bootable from USB (built with `mkarchiso`-like Synthex tooling)
- Contains a rescue shell, BTRFS tools, snapper, `chroot` helper
- Automatically detects and mounts existing Synthex installations
- One-click rollback to any snapper snapshot
- Rebuilds initramfs and UKI if boot partition is corrupted
- Runs `dnf5 reinstall` on critical packages

---

## 14. Release Engineering Approach

### 14.1 Release Cadence

| Release Type | Cadence | Description |
|---|---|---|
| **Rawhide (development)** | Continuous | Daily builds, Fedora Rawhide rebase every 2–4 weeks. NOT for production use. |
| **Synthex-N (stable)** | ~6 months | e.g., Synthex-25 (2025.1), Synthex-25 (2025.2). Named after year + sequence. |
| **Synthex-LTS** | ~24 months | Long-term support spin with kernel LTS (6.6.y). Minimal DE update, security-only patches. |
| **Security hotfix** | As needed | Emergency .z release (e.g., Synthex-25.0.1). Fast-tracked within 24 hours. |

### 14.2 Release Lifecycle

```
Phase 1: Rawhide (development) ───────────────────────────────────
    ↓ (feature freeze)
Phase 2: Alpha (package freeze, kernel freeze)
    ↓ (up to 4 weeks of stabilisation)
Phase 3: Beta (string freeze, UI freeze)
    ↓ (up to 2 weeks)
Phase 4: Release Candidate
    ↓ (RC1 → RC2 → ... → final)
Phase 5: Stable Release
    ↓ (~6 months of active support)
Phase 6: End-of-Life (EOL) — archive repository
```

| Release | Fedora Base | Kernel | KDE Plasma | Support Window |
|---|---|---|---|---|
| Synthex-25.1 | Fedora 40 | 6.8–6.12 | 6.1 | Apr 2025 – Oct 2026 |
| Synthex-25.2 | Fedora 41 | 6.11–6.14 | 6.2 | Oct 2025 – Apr 2027 |
| Synthex-26.1 | Fedora 42 | 6.14+ | 6.3 (planned) | Apr 2026 – Oct 2027 |

### 14.3 Release Automation

Release creation is semi-automated with human-in-the-loop gates:

```bash
# 1. Branch from rawhide
git checkout -b synthex-26.1 rawhide

# 2. Update release version across all packages
./scripts/bump-release.py synthex-26.1

# 3. Run full CI build (blocking)
./ci/pipeline.py --release synthex-26.1

# 4. Generate ISO images
./build/mkiso.sh --flavor plasma --version 26.1

# 5. Sign ISOs + generate checksums
./scripts/sign-iso.sh --hsm-user release_manager

# 6. Staging deploy → QA team tests
./scripts/deploy-staging.sh

# 7. QA sign-off → production push
./scripts/promote-to-production.sh
```

### 14.4 QA and Testing

| Test Stage | Tooling | Scope |
|---|---|---|
| **Unit (per-package)** | `rpmlint`, `abidiff`, `check` | Package-level spec linting, ABI comparison against previous |
| **Integration (system)** | `autopkgtest` / `cockpit` | Boot, DE startup, basic application launch, network, sound |
| **Regression** | `beakerlib` | 200+ automated test scenarios across all DEs |
| **Hardware compat** | `hardware-test-day` (community) | Community-run HCL database with ~1000+ hardware configurations |
| **Performance** | `phoronix-test-suite` | Benchmark comparison against previous release and Fedora Workstation |
| **Security** | `osv-scanner`, `grype`, `openscap` | CVE scanning of all packages; hardening profile validation |
| **Upgrade** | `tmt` (test management tool) | Upgrade from previous stable to new release on real hardware + VMs |
| **Gaming** | `proton-ge` test suite | Playability of Top 100 Steam Deck Verified games |

### 14.5 Community Involvement

| Role | Responsibility | Path |
|---|---|---|
| **Package Maintainer** | Maintains 1+ packages in synthex-* repositories | Proven packager + 3 months contribution |
| **QA Tester** | Runs pre-release test scenarios | Active on Matrix + bug tracker |
| **Documentation Writer** | Maintains arch, user, and API docs | Documentation PR history |
| **Release Manager** | Owns the release checklist, signs ISOs | Elected by core team, trusted + keyholder |
| **Security Team** | Tracks CVEs, prepares security patches | Invite-only, GPG-signed commits mandatory |

---

## Appendix A: Architecture Decision Records (ADRs)

Key decision | Rationale | Date
---|---|---
Wayland-only, no X11 | Eliminates X11 security surface, aligns with upstream direction, simplifies compositor testing | 2024-Q2
BORE+EEVDF over CFS/BORE-only | Balanced fairness and latency; EEVDF upstream merge ensures future kernel compatibility | 2024-Q3
systemd-boot over GRUB | Reduced boot complexity, native UKI support, simpler Secure Boot, faster boot | 2024-Q3
BTRFS over bcachefs (default) | Mature snapshot ecosystem (snapper), send/receive, wider community testing; bcachefs opt-in | 2024-Q3
DNF5 over DNF4 | Faster dependency resolution, C++ rewrite, better modularity, smaller footprint | 2024-Q4
Flatpak + RPM dual strategy | RPM for tight system integration; Flatpak for sandboxed, versioned app delivery | 2024-Q2
SELinux over AppArmor | Fedora base compatibility, richer policy language, better audit tooling | 2024-Q2
Rolling core + snapshotted releases | Freshness without instability; snapshots provide escape hatch | 2024-Q3

## Appendix B: Core Package Manifest (Baseline)

A minimal Synthex Core installation comprises approximately 450 packages. Key components:

| Area | Packages |
|---|---|
| **Boot** | systemd-boot, dracut, sbctl, pesign |
| **Init** | systemd, systemd-resolved, systemd-oomd, systemd-homed |
| **Kernel** | kernel-synthex, kernel-modules-extra, linux-firmware |
| **Toolchain** | clang, lld, compiler-rt, gcc, glibc, binutils, rustc |
| **Security** | selinux-policy-synthex, selinux-policy-targeted, auditd, fapolicyd |
| **Networking** | NetworkManager, systemd-resolved, firewalld, nftables |
| **Storage** | btrfs-progs, snapper, lvm2, cryptsetup, udisks2 |
| **Audio** | pipewire, wireplumber, pipewire-pulseaudio, alsa-ucm-conf |
| **Display** | mesa, mesa-vulkan-drivers, libglvnd, libdisplay-info, libliftoff |
| **GPU** | mesa-{radeon,amd,intel}, nvidia-open (kmod), vulkan-loader |
| **DE** | plasma-desktop, plasma-wayland-session, kwin, sddm |
| **Package Mgmt** | dnf5, dnf5-automatic, flatpak, rpm-ostree (optional) |
| **AI** | synthex-hermes, synthex-ai-runtime-rocm, synthex-ai-runtime-llamacpp |

## Appendix C: Hardware Requirements

| Component | Minimum | Recommended (Gaming) | Recommended (Enterprise) |
|---|---|---|---|
| **CPU** | 2 cores, x86_64 v2 | 8+ cores, x86_64 v3 (AMD Zen 4 / Intel 13th gen) | 6+ cores, v3 |
| **RAM** | 4 GB | 32 GB DDR5 | 16 GB ECC |
| **GPU** | Mesa-capable (GCN5+) / Intel Gen9+ | RDNA3+ / RTX 40-series | RDNA2+ / RTX 30-series |
| **Storage** | 64 GB SSD | 1 TB NVMe | 512 GB NVMe + BTRFS RAID1 |
| **Display** | 1366×768 | 2560×1440+ 144Hz HDR | 1920×1080 |
| **TPM** | TPM 2.0 (recommended) | TPM 2.0 | TPM 2.0 (required for measured boot) |
| **Network** | Any | Gigabit Ethernet + Wi-Fi 6E | Any |

---

*This document is the authoritative architecture reference for the Linux Synthex project and should be consulted before making significant architectural decisions. Questions, corrections, and proposals should be filed against the `architecture/` directory in the project repository.*
