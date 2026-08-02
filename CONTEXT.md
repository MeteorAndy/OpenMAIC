# OpenMAIC Desktop

This glossary defines the product language for the installable OpenMAIC desktop experience.

## Language

**Desktop Edition**:
The installable OpenMAIC product supported on Windows 10 and Windows 11 x64. SaaS capabilities and macOS or Linux distributions are outside its current product boundary.
_Avoid_: Tauri branch, desktop mode

**Desktop Release**:
A versioned Windows x64 distribution of Desktop Edition that has passed the desktop release gate. It upgrades in place through a newer installer and preserves Workspace Data; automatic updating is outside the current boundary.
_Avoid_: Build artifact, debug build, package release

**Desktop Version**:
The single semantic version shared by all Desktop Edition manifests and published with a `desktop-vX.Y.Z` tag. It is independent of the Web product's `vX.Y.Z` release sequence.
_Avoid_: Web version, package version, installer revision

**Desktop Release Gate**:
The approval boundary that turns a verified Release Candidate from the latest desktop release branch commit into an Authenticode-signed Desktop Release. A successful release creates its `desktop-vX.Y.Z` tag rather than trusting a pre-existing tag as authorization.
_Avoid_: Tag build, CI artifact, automatic publish

**User Installation**:
A copy of Desktop Edition installed for one Windows user account without requiring machine-wide administration. Its Workspace Data, Provider Credentials, and running Desktop Instance are isolated from other Windows accounts.
_Avoid_: Machine installation, shared workstation instance, portable app

**Release Candidate**:
An internal Desktop Edition build awaiting required release approval or Authenticode signing. It may be used for verification but is not a Desktop Release and must not be publicly distributed as one.
_Avoid_: Unsigned release, final installer

**Workspace Data**:
User-created and user-configured local content owned by Desktop Edition, including classrooms, scenes, media, and settings. It survives upgrades and ordinary uninstallation unless the user explicitly requests deletion.
_Avoid_: Cache, temporary files, application binaries

**Active Workspace**:
The mutable Workspace Data currently owned and opened by a User Installation. It is distinct from exported Recovery Snapshots and has one Desktop Edition-managed storage location.
_Avoid_: Backup folder, user-selected data directory, shared workspace

**Recovery Snapshot**:
A complete, validated and portable representation of Workspace Data and non-sensitive settings at one point in time. It is not encrypted; restoring it deterministically replaces the current state through a rollback-capable process rather than merging unrelated records.
_Avoid_: Data import, partial backup, Provider Credentials

**Upgrade Safety Snapshot**:
The most recent Recovery Snapshot created automatically before a compatibility-breaking Workspace Data migration. It remains available until a replacement safety snapshot has been created and validated.
_Avoid_: User backup, restore point, temporary migration file

**Workspace Compatibility Gate**:
The boundary that determines whether a Desktop Edition version may open existing Workspace Data. An incompatible older version leaves the data unchanged and enters Recovery Mode instead of attempting a downgrade.
_Avoid_: Best-effort downgrade, schema warning, migration prompt

**Desktop Instance**:
The single running Desktop Edition process that owns the active workspace. Launching Desktop Edition again activates this process instead of creating another one.
_Avoid_: Sidecar, browser tab, worker

**Local Service**:
The private companion service owned by the active Desktop Instance. It is not a general localhost API and accepts authenticated requests only from its owning Desktop Instance.
_Avoid_: Local sidecar, development server, public API

**Recovery Mode**:
The native Desktop Edition state shown when the Local Service or Active Workspace cannot safely operate. It offers bounded, user-selected recovery and diagnostic actions without automatically overwriting Workspace Data.
_Avoid_: Crash loop, blank window, fatal exit

**Diagnostic Bundle**:
A user-initiated export of bounded, redacted Desktop Edition logs and environment metadata for troubleshooting. It excludes Provider Credentials and user content by default and is never uploaded automatically.
_Avoid_: Telemetry dump, workspace backup, automatic crash report

**Offline Session**:
A Desktop Edition session without internet access in which existing Workspace Data remains available for browsing, editing, playback, backup, and export. Network-backed capabilities are explicitly unavailable rather than making the application appear broken.
_Avoid_: Degraded startup, disconnected Local Service, offline generation

**Provider Credentials**:
Secrets that authorize Desktop Edition to use external model, media, search, speech, or document services. They are device-protected values, not Workspace Data or ordinary settings.
_Avoid_: Provider settings, API configuration, backup data

**Trusted Provider Endpoint**:
A provider network destination that Desktop Edition is permitted to contact. Explicit local providers may use loopback endpoints, private-network endpoints require specific user approval, and infrastructure-sensitive destinations can never qualify.
_Avoid_: ALLOW_LOCAL_NETWORKS, arbitrary URL, trusted host
