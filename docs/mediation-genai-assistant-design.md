# AdMob Mediation GenAI Assistant — Design Document

**Status:** Draft · **Target:** Q4 2026

---

## 1. Executive Summary & Problem Statement

### 1.1 Objective

Integrate a conversational GenAI assistant panel into the AdMob Frontend (FE) Mediation interface. The assistant streamlines complex mediation group management workflows by supporting contextual Q&A, programmatically assembling and mutating draft mediation group configurations from natural language, and triggering client-side route navigation. To guarantee data integrity, all persistent account modifications are gated behind an explicit frontend confirmation card.

### 1.2 Background & Problem Space

Configuring AdMob Mediation represents one of the steepest learning curves for new and intermediate mobile publishers. Creating an optimized mediation group requires:

- Navigating multi-step, deeply nested wizards.
- Configuring a mix of bidding (real-time) and waterfall (manual eCPM) networks.
- Mapping ad units to specific geolocations and platforms.
- Managing third-party ad source credentials and mapping configurations.

The current user experience requires significant context-switching between external documentation (Help Center) and the AdMob console. Integrating an agent-driven chat UI will significantly reduce this friction by allowing users to declare their intent (e.g., "Add AppLovin to my Android banner group with a $1.20 floor") and having the system actuate the UI accordingly.

## 2. Goals & Non-Goals

### 2.1 Goals

- **Contextual Assistance:** Provide users with answers about their existing mediation groups using the backend Data API as the source of truth for transactional states, and the AdMob Reporting Service for metrics.
- **Programmatic Draft Assembly:** Allow users to dictate configuration changes (e.g., adding networks, setting eCPM floors, changing names) which the assistant translates into client-side UI state mutations.
- **Strict Write Gating:** Ensure that no GenAI-initiated mutation is saved to the backend without explicit user consent via a client-side Confirmation Card.
- **Local Testability:** Ensure the entire stack can run on the AdMob local server environment.

### 2.2 Non-Goals

- **A/B Testing Generation:** The assistant will NOT create or manage AdMob Mediation A/B experiments automatically.
- **Autonomous Unsupervised Writes:** The assistant will NEVER execute database writes (via `MediationGroupService`) without the user clicking "Apply" on a confirmation card. There is no bypass path: no payload field, flag, or configuration may waive the confirmation requirement.
- **Cross-Product Configuration:** The assistant will only operate within the AdMob Mediation domain (no AdSense or Google Ads campaign management).

## 3. High-Level System Architecture

The architecture relies on a strict separation of concerns between the AngularDart frontend (managing UI state and execution) and the Java application-framework backend (hosting the ADK agent runner and resolving queries).

### 3.1 Frontend (AdMob FE)

- **Framework:** AngularDart (located in `google3/ads/admob/fe/inventory/mediation_groups/`).
- **State Management:** Redux pattern (Stores, States, Reducers, Selectors) in Dart to handle UI updates and action flows. The primary store interacted with is `MediationGroupEditorStore`.
- **Client API Service:** `MediationGroupService` (Dart wrapper around the RPC stub `Ng2ProtoMediationGroupService`) triggers actions on the backend.
- **UI Component:** The Shared Chat UI Library (`ads/acx2/components/contrib/chat`).
  - Standardizes GenAI chat layouts across Ads products.
  - Utilizes a `MessageRenderConfigRegistry` to resolve message renderers dynamically.
  - Supports markdown-to-HTML rendering natively. We will register custom interactive components (like write confirmation cards) under custom `rendererId` keys. Registration of feature-specific renderers happens at the feature (mediation) level; the shared chat component itself is unmodified.

### 3.2 Backend (AdMob FE App Server)

- **Framework:** The Java/Kotlin RPC application framework used by the AdMob FE server.
- **DI Framework:** Guice.
- **RPC Endpoint Handler:** `MediationGroupServiceModule` binds RPC actions for the endpoints (e.g., `/mediationGroup/_/rpc/MediationGroupService/Get` or `V2Create`).
- **Programming Model:** Producers and ActionProducers (e.g., `MediationGroupListProducerModule`, `MediationGroupUpdateV2ProducerModule`). ActionProducers will trigger the ADK agent runner asynchronously when a chat RPC is received.
- **Agent Engine:** ADK Runner, embedded within the backend to handle the orchestration loop, tool execution, and session state management.

### 3.3 Data Access Layer (Standard Backend Access)

AdMob FE backend reads and writes are strictly divided between transactional database settings and historical analytics:

- **Transactional Settings (Data API):** Java-side data retrieval and mutation are performed via standard Data API DAOs (e.g., `DataApiGetMediationGroupDao`, `DataApiUpdateMediationGroupDao`) injected from `com.google.ads.admob.fe.inventory.api.ui.dao.*`. These DAOs connect to the display ads storage backend.
- **Historical Performance (AdMob Reporting Service):** Multi-dimensional analytics (revenue, impressions) are retrieved via the `DataApiReportingDao`.
- **Local Setup:** Bypasses configured to run the local AdMob stack (`admob_everything_local`) without remote permission blocking.

## 4. Implementation Plan (Phased Rollout)

To ensure stability and local testability, development will proceed in five distinct phases.

### Phase 1: Fix the Local Server

Ensure the AdMob local server stack compiles and runs locally without permission errors, using configuration bypasses for missing remote services. This guarantees a safe sandbox for development.

### Phase 2: Basic Chat Integration (No Tools)

Wire up the `ads/acx2/components/contrib/chat` AngularDart frontend to communicate with a new ActionProducer (RPC) on the backend. We will embed the ADK Runner here, configured with zero tools.

**Objective:** Verify full network roundtrip, RPC integrity, and UI rendering of basic conversational text. Exit criteria additionally include pinning the two integration seams in this document: (a) the chat panel's mount point in the mediation page and the owner of `sessionId` minting; (b) the exact ToolCall JSON + `rendererId` contract (§7.2).

### Phase 3: Frontend Actuation & Context

Implement the Just-In-Time (JIT) `MediationPageContextProvider` so the agent can "see" the active draft state. Implement frontend execution directives (`NAVIGATE`, `INITIALIZE_DRAFT`, `SET_NAME`, `HighlightDirective`) allowing the agent to programmatically manipulate the Redux store without touching the backend databases.

### Phase 4: Backend Data Reads (Data API DAOs)

Introduce backend read tools to the agent. By wrapping `DataApiGetMediationGroupDao` and `DataApiListMediationGroupsDao` read operations, the agent can securely read the publisher's actual active mediation setups and answer contextual queries (e.g., "What is my active iOS group?").

### Phase 5: Write-Gating & Confirmation Cards

Implement the change-proposal contract (§7.2) and the custom `MediationGroupConfirmationCardComponent`. The agent will output write proposals, intercepted by the frontend, rendered as interactive cards, and finally executed via `MediationGroupService` (which delegates to the backend RPC handler) only upon user approval.

## 5. Detailed Design: Frontend Directives & Core Workflows

The GenAI Mediation Assistant supports cohesive, codebase-integrated user journeys that manage state updates natively.

### 5.1 Interactive Draft Assembly

- **Scenario:** User says: *"Create an Android banner group named 'Holiday Promo'."*
- **Execution Flow:**
  1. The agent processes the request and returns execution directives: `NAVIGATE(route: "/mediation/create")`, `INITIALIZE_DRAFT(platform: "ANDROID", format: "BANNER")`, and `SET_NAME(name: "Holiday Promo")`.
  2. **AdMobLinker:** Programmatically routes the SPA to the mediation group creation flow (`MediationRoutes.mediationGroupCreationPath`).
  3. **MediationGroupEditorStore:** Once the creation page transitions to `PageState.editor`, the frontend directly mutates properties like `platform`, `format`, and `nameControl` on the `MediationGroupModel`.
  4. **HighlightDirective:** Applies a visual flash styling to each updated field to draw user attention to the automated change.

### 5.2 Ad Source Waterfall Setup

- **Scenario:** User says: *"Add AppLovin to this waterfall and set its floor to $1.20."*
- **Execution Flow:**
  1. The agent returns directives: `ADD_AD_SOURCE(adapter: "AppLovin")` and `UPDATE_ECPM(micros: "1200000")`.
  2. **MediationGroupEditorStore:** The controller calls `createNetworkCallAction(appLovinAdapter)` followed by `updateEcpmAction(networkCall, 1200000)`.
  3. `createNetworkCallAction` instantiates the new `ThirdPartyNetworkCall` and updates the model's `callCollection`. The subsequent eCPM update targets the call resolved by its ad-source identifier (never by list position).
  4. `updateEcpmAction` mutates the call's `ecpm` field, validates, and forces a state stream emission.

### 5.3 Wizard Interception & Partial Configuration

- **Scenario:** User says: *"Target ad unit 'iOSBanner_1' in this group."*
- **Execution Flow:**
  1. The frontend controller checks the active draft.
  2. If waterfall networks are present, it blocks direct mutation to avoid mapping mismatches.
  3. It calls `onAddAdUnitsClicked()` in `AdUnitTable`, toggling `isModalVisible = true` to launch the `AddAdUnitModal` wizard with the target ad unit pre-selected, prompting the user to complete placement configurations manually.

### 5.4 Directive Execution Is Visible and Reviewable

Every store mutation the assistant performs is:

- **(a) Highlighted in place** via `HighlightDirective`;
- **(b) Summarized in the chat transcript** ("Set format to Banner · Set platform to Android · Named it 'Holiday Promo'");
- **(c) Revertible from that summary** — each summarized item is an operation with a known inverse, applied through the same store actions. (v1 may ship a single "revert assistant changes" affordance if per-operation revert is not feasible in the editor store.)

This keeps the editor page the single review surface: the user watches the form being filled, and can undo, with no added confirmation ceremony for reversible draft edits.

### 5.5 Panel States, Empty State, and Degraded Mode

- **Empty state:** three context-sensitive suggestion chips per page type (group list: "Create a mediation group", "Which of my groups has the lowest match rate?"; editor: "Add a bidding source", "Explain eCPM floors").
- **Streaming states:** thinking indicator before the first token; token streaming; a subtle execution shimmer on the editor region a directive is about to change.
- **Degraded mode:** when the agent backend is unavailable or over quota, the panel shows a calm banner ("The assistant is unavailable right now"), suggestion chips gray out, and the editor is entirely unaffected. The assistant must never block or degrade the manual editing path.
- **Error taxonomy (all copy localized, no raw exception text in the UI):** model-unavailable; proposal-invalid (with the specific unmet requirement, §7.4); apply-failed (backend rejection mapped to product language); context-too-large.

## 6. State Synchronization & Page Context

To prevent state divergence where the user manually edits the draft and the assistant remains unaware, we will implement **Just-In-Time (JIT) Page Context Injection**.

### 6.1 The `MediationPageContextProvider`

We will create a new AngularDart service called `MediationPageContextProvider` that implements the standard `ContextProvider` pattern.

- **JIT Extraction:** When the user clicks "Send" in the chat panel, the UI pauses, invokes `MediationPageContextProvider.getContext()`, and extracts the *latest* active draft state directly from `MediationGroupEditorStore`.
- **Context Serialization:** The active `MediationGroupModel` is serialized into a lightweight JSON payload and bundled into the backend RPC alongside the user's prompt.
- **Page identity is a type, not a route literal:** the payload carries `page_type ∈ {GROUP_LIST, GROUP_CREATE, GROUP_EDITOR, OTHER}` resolved from the router, with the raw route included only for debugging. The model reasons over page types.
- **Explicit empty state:** when no draft is active, the payload states it (`"draft_state": null`) rather than sending an empty object.
- **List-page context:** on the group list, the payload includes a bounded summary of visible groups (name, format, platform, status; count-capped with an explicit `"truncated": true` marker when cut) so requests like "pause the iOS banner group" are groundable.
- **Bounds:** ad-source and ad-unit lists in the payload are size-capped with explicit truncation markers, keeping prompt cost and latency managed.
- **Example Payload:**

```json
{
  "user_message": "Does this floor price look okay?",
  "page_context": {
    "page_type": "GROUP_CREATE",
    "draft_state": {
      "name": "Holiday Promo",
      "platform": "ANDROID",
      "format": "BANNER",
      "ad_sources": [
        { "adapter_id": "AppLovin", "is_bidding": false, "ecpm_micros": "1200000" }
      ],
      "ad_unit_ids": []
    }
  }
}
```

All eCPM values are encoded as **int64-as-string micros** (`"1200000"` = $1.20) everywhere in the system: context payloads, proposals, and examples. Absent values are omitted, never serialized as `0`.

### 6.2 Manual User Edits During LLM Streaming

- **Conflict:** The user manually types into an input field while the backend agent is concurrently streaming a response that attempts to mutate the state.
- **Resolution:** The frontend controller maintains a dirty flag during streaming. If user interaction is detected on the main UI pane, the frontend prioritizes the manual edits and discards the agent's conflicting directive.
- **The discard is visible:** the transcript shows a non-blocking notice — "Kept your edit to *Name*; skipped the assistant's change" — and the discard is fed back into the model's context so its next turn does not assume the mutation happened.

## 7. Gated Execution & Write Confirmation Architecture

To safely allow GenAI mutations, AdMob Frontend implements a write-gating mechanism, utilizing the `MessageRenderConfigRegistry` to resolve a custom interactive component.

```
sequenceDiagram
    participant User
    participant ChatPanel as Frontend Chat Panel
    participant ConfCard as MediationGroupConfirmationCard
    participant Executor as MediationMutateExecutor
    participant Service as MediationGroupService
    participant Backend as AdMob Backend Agent

    User->>ChatPanel: "Save the group"
    ChatPanel->>Backend: Request (Query + JIT page context)
    Backend-->>ChatPanel: Stream Response (proposal JSON + rendererId 'mediation_confirm')
    ChatPanel->>ConfCard: Render card from proposal
    Note over ConfCard: User reviews proposed modifications
    User->>ConfCard: Click "Apply"
    ConfCard->>Executor: executeMutate(proposal)
    Executor->>Executor: Validate entire proposal (schema, adapters, §7.4 gates)
    Executor->>Service: createMediationGroup(model) or updateMediationGroup(model)
    Service-->>Executor: Mutate result (Success/Error)
    Executor-->>ConfCard: Update card state (applied / failed)
```

### 7.1 Client-Side Execution Rationale

The assistant executes mutations **client-side** via `MediationGroupService`:

1. **Stateful UI Synchronization:** The AdMob FE Mediation interface is a highly stateful multi-step wizard managed by `MediationGroupEditorStore`. Triggering updates directly in the client ensures that the UI state, form validations, and store caches remain perfectly synchronized.
2. **Validation Safeguards:** Mutating via `MediationGroupService` on the client guarantees that all standard client-side business logic and validations are enforced *before* any RPC is dispatched to the backend.

### 7.2 The Change-Proposal Contract (canonical)

Write proposals are streamed by the backend as a JSON payload attached to a chat message with `rendererId: "mediation_confirm"`. This JSON schema is the single canonical contract; the card and the executor consume exactly this shape.

```json
{
  "schema_version": 1,
  "proposal_id": "uuid-string",
  "change_description": "Add AppLovin to the waterfall at a $1.20 eCPM floor.",
  "name": "Holiday Promo",
  "ad_source_mutations": [
    {
      "adapter_id": "AppLovin",
      "is_bidding": false,
      "is_removed": false,
      "ecpm_micros": "1200000"
    }
  ],
  "ad_unit_ids": ["iOSBanner_1"]
}
```

Contract rules:

- **`proposal_id` is required** and is the idempotency key for Apply/retry and the identifier used in transcript history.
- **`schema_version` is required** so the payload can evolve after launch.
- **Optional top-level fields (`name`, `ad_source_mutations`, `ad_unit_ids`) are proposals only when present.** Absent means "no change proposed."
- **Absent means untouched, never zero:** an `ad_source_mutations` entry that omits `ecpm_micros` leaves the existing eCPM unchanged. Values are never defaulted.
- **`ad_unit_ids` is a full replacement** of the group's targeted ad units when present.
- **Fail closed on unknowns:** a proposal containing an unrecognized field or operation is rejected and rendered as "couldn't understand this proposal"; it is never partially applied.
- **Size bounds:** proposals are capped (max ad-source mutations, max ad-unit IDs); oversized proposals fail validation.
- **All model-authored text (`change_description`) renders as plain text**, never as markup.

### 7.3 Confirmation Card Component (`MediationGroupConfirmationCardComponent`)

A new AngularDart component, registered as a custom `rendererId` for the shared chat library **from the mediation feature module**, handles user interaction and gates mutations.

**Anatomy:**

- Title: "Review proposed changes".
- The `change_description`, one sentence, plain text.
- A **diff list**, one line per operation, always showing before → after values in human units: "AppLovin · waterfall · eCPM $0.80 → **$1.20**", "Add Pangle · bidding", "Remove Unity Ads". Micros are always rendered as currency, never raw.
- Contextual warnings where applicable ("Removing Unity Ads stops its traffic immediately after this is applied").
- When the editor holds unsaved manual edits, a distinct disclosure line: *"Also saves your N unsaved edits to this group"* (expandable to enumerate them). One click, complete information.
- Actions: **Apply** (primary) and **Dismiss** (secondary).

**State machine:**

`review → applying (spinner, actions disabled) → applied (✓ summary) | failed (mapped message + Retry / Revert) | dismissed (collapsed one-liner) | stale (Apply disabled)`

- Transitions are one-way except `failed → applying` (retry).
- **Dismiss** marks the proposal rejected, collapses the card, and informs the conversation context so the model does not re-propose the same change verbatim.
- A proposal becomes **stale** when the underlying context changes before action (the user navigates away, edits the group, or a newer proposal supersedes it): the card disables Apply and shows "This proposal no longer matches the current state — ask again."
- Applied and dismissed cards remain in the transcript as the visible record of what was and wasn't approved.
- Double-click protection: Apply is inert while `applying`.

**Localization & accessibility:** all card and panel strings go through the standard message-bundle process; status is conveyed by text, not glyph alone; card render and state transitions are announced via a live region; focus moves to the card on render and returns to the composer on dismissal; Apply/Dismiss are keyboard-reachable. WCAG 2.1 AA, matching the rest of the AdMob frontend.

### 7.4 Apply Semantics

Apply is the product's **single confirmation**: clicking it validates, stages, and commits in one user action, with these guarantees:

1. **Validation parity with Save.** Apply enforces the same validity gates as the editor's own Save (model validity, complete placement mappings). If the proposal produces an invalid or incompletely-mapped configuration, Apply fails closed *before any commit*, and the card explains the unmet requirement ("AppLovin needs placement mappings for 2 ad units before this group can be saved") with a pointer to the relevant editor step. The §5.3 wizard-interception rule applies to the Apply path exactly as it applies to the directive path.
2. **Validate first, then apply.** The entire proposal is validated up front (every adapter resolves; every value in range; resulting configuration passes the gates above). An invalid proposal changes nothing.
3. **Atomic from the user's perspective.** After Apply, the group reflects all proposed changes or none. On a failed commit, the editor shows the staged-but-uncommitted state and the card offers **Retry** and **Revert**.
4. **Idempotent retry, keyed by `proposal_id`.** Retrying a failed Apply never double-adds a source or re-applies an already-applied change: retry re-commits the already-staged state; it does not re-execute the mutation sequence.
5. **Domain rules enforced at validation:**
   - **Bidding sources have no manual eCPM.** A mutation with `is_bidding: true` must not carry `ecpm_micros`; if it does, the proposal fails validation. Manual eCPM applies to waterfall entries only.
   - **Platform and format are creation-time choices.** They may be set by `INITIALIZE_DRAFT` for a new group but are not mutable on an existing group; proposals against existing groups that include them fail validation with a clear message.
   - **Ad-source targets must resolve.** A mutation whose `adapter_id` does not match a configured adapter fails validation with a clear message.

## 8. Security & Privacy Considerations

- **No PII Logging:** The Chat UI will strictly sanitize user inputs and context payloads. No Publisher IDs, Ad Unit IDs, or application names will be logged to plain-text analytics.
- **Authorization Context:** All RPC calls initiated by `MediationGroupService` on behalf of the GenAI executor will inherit the exact same session authorization as the standard web UI. The agent possesses no elevated privileges.
- **No autonomous execution:** streamed tool calls render as proposals; nothing executes on stream arrival. The only write path is a user's Apply click.

## 9. Testing Strategy

- **Local Sandbox Validation:** Developers must validate all 5 phases against the local environment using the local-stack bypasses.
- **Unit Tests:**
  - `MediationPageContextProvider` must be unit tested to ensure it correctly serializes `MediationGroupModel` (including the explicit no-draft marker and truncation bounds).
  - `MediationGroupConfirmationCardComponent` must be tested using `TestComponent` wrappers to simulate "Apply" and "Dismiss" clicks and every card state transition (including `stale`).
  - `MediationMutateExecutor` must be unit tested against the §7.4 contract: absent-eCPM leaves values untouched; bidding+eCPM fails validation; add/update/remove paths; ad-unit replacement semantics; validation-parity refusals; idempotent retry.
- **E2E Tests:** WebDriver tests will simulate a user typing a prompt, verifying the chat panel UI rendering, and asserting that the `MediationGroupEditorStore` state successfully mutates — covering the happy path, the dismiss path, the stale path, the failed-apply path, and the §6.2 conflict path.
