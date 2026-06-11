# SLACK-WEBHOOK-HUB — 스펙 v0.1

> **출처**: P1-3-B 후속 논의 (2026-06-05). Slack → Claude 작업 트리거의 즉각화 + 멀티 프로젝트 허브.
> **관계**: 폴링 routine(`trig_01F3b24fyHFpZJbHfHumuxwt`, cron 1시간)의 즉각성 한계를 이벤트 웹훅으로 보완. **별도 프로젝트**로 구축.
> **우선순위**: P2 (폴링으로 당장 동작 중, 즉각성은 개선 과제)
> **작성 시점**: 2026-06-05

---

## 1. 배경 & 목표

- **현재 상태**: Slack 폴링 routine이 `#jullyssy`의 `클로드,` 명령을 cron으로 처리. cron 하한이 1시간이라 **최대 1시간 지연**.
- **한계**: cron 최소 간격 1시간. staggered(routine N개 시차 배치)로 60/N분까지 단축 가능하나, 명령이 없어도 N개가 계속 도는 **빈 폴링 비용 N배**.
- **목표**:
  1. **이벤트 기반 즉각(초 단위)** 트리거 — 명령 있을 때만 실행(평소 비용 0)
  2. **채널별 멀티 프로젝트 라우팅** — `#projectA`→projectA, `#projectB`→projectB
  3. **특정 프로젝트 비종속** — 독립 허브 (jullyssy 배포가 단일점이 되지 않도록)
- **비목표**: Slack 외 플랫폼(추후), 멀티턴 대화 세션(단발 명령만 처리).

---

## 2. 핵심 결정: 왜 별도 프로젝트인가

웹훅 수신 엔드포인트를 jullyssy 안에 두면 **jullyssy 배포가 전체 Slack 제어의 단일점**이 된다(jullyssy가 죽으면 모든 프로젝트 제어 중단). 허브로 분리하면:

```
Slack 앱 1개 (워크스페이스 레벨, 모든 채널 커버)
        │  채널 메시지 이벤트
        ▼
허브 엔드포인트 1개 (독립 Vercel 프로젝트)
   ├─ 서명 검증 + 즉시 200 ack
   ├─ 채널 → 프로젝트/실행대상 라우팅
   └─ 비동기 실행 트리거
        │
        ▼
프로젝트별 실행 (routine N개 또는 Agent SDK)
        │  작업 수행
        ▼
Slack thread 회신 (결과 알림)
```

- **Slack 앱**: 1개로 전부 커버
- **허브**: 1곳 (채널→대상 라우팅)
- **실행 대상**: 프로젝트마다 1개 (각자 repo 작업)

---

## 3. 컴포넌트

### 3.1 Slack 앱 (워크스페이스 레벨)
- **Event Subscriptions**: `message.channels` (또는 `app_mention`으로 범위 축소)
- 봇 토큰(`xoxb-...`), **Signing Secret**
- Request URL = 허브 엔드포인트
- 대상 채널에 봇 초대

### 3.2 허브 엔드포인트 (별도 Vercel 프로젝트)
`POST /api/slack/events` (Next.js Route Handler 또는 경량 서버):
1. **서명 검증** — `x-slack-signature` HMAC-SHA256 (`v0:{ts}:{rawBody}`), timestamp ≤ 5분
2. **url_verification** challenge 응답 (Slack 앱 등록 시)
3. **즉시 200 ack** — Slack 3초 타임아웃 + 재시도 방지. `X-Slack-Retry-Num`이 있는 재전송 요청은 서명 검증 후 200 ack만 반환하고 executor를 실행하지 않음. `bot_id` 메시지 필터
4. **비동기 작업 시작** — ack 후 백그라운드
5. **채널 → 라우팅** — `channel_id`로 실행 대상 결정

### 3.3 라우팅 테이블
- `channel_id` → `{ project, executor, triggerId, tokenEnv }`. 예: `C0B89G83HV1`(#jullyssy) → jullyssy routine.
- 저장: 현재는 `SLACK_ROUTES_JSON` env. 비밀 토큰은 JSON에 넣지 않고 `tokenEnv`로 별도 env를 참조. 추후 Supabase 테이블 또는 Vercel Edge Config로 확장 가능.
- **이 테이블이 곧 채널 화이트리스트**(미등록 채널 무시).

### 3.4 실행 경로 — A vs B (Phase 0에서 확정)

**경로 A: routine run-now 재사용**
- `RemoteTrigger` 의 `run` (`POST /v1/code/triggers/{id}/run`)을 허브에서 호출.
- ⚠️ **블로커**: `RemoteTrigger`는 claude.ai 세션 내 OAuth(in-process, curl 금지)로 동작. **외부 서버(허브)에서 routine을 발사하는 공식 인증 방법이 있는지 미확인.** API 토큰 발급 경로 존재 여부 = Phase 0 핵심 검증.
- 장점: 프로젝트별 기존 routine을 그대로 재사용. 단점: 외부 발사 인증 불확실.

**경로 B: Claude Agent SDK 직접 실행**
- 허브가 `@anthropic-ai/claude-agent-sdk`로 Claude를 직접 실행 (Anthropic API 키).
- codebase context = repo clone (Vercel Sandbox 또는 Agent SDK 워크스페이스 옵션).
- 장점: 인증 명확(API 키), 즉각. 단점: **긴 작업 = Vercel 실행시간 한계** → fluid compute(300s+) 또는 큐 + 백그라운드 워커 필요.

### 3.5 멱등 / 큐
- Slack 재시도 대비 1차 방어: `X-Slack-Retry-Num`이 있는 요청은 서명 검증 후 `{ ok: true, ignored: "slack_retry" }`로 ack하고 executor를 실행하지 않음.
- 현재 방식의 tradeoff: DB 멱등 저장소가 없으므로, 첫 delivery가 작업 예약 전에 실제 실패한 경우 retry가 드롭될 수 있음. 정확한 멱등/복구는 아래 향후 DB 멱등으로 해결.
- 향후 DB 멱등: `event_id`(또는 `message_ts`)로 처리 여부 저장.
- 허브 Supabase `command_log` — jullyssy의 `slack_command_log`(046) 스키마 재사용 가능.
- 긴 작업은 큐(Supabase/Vercel Queues) 적재 → 완료 시 `chat.postMessage`.

---

## 4. 보안

- **Slack 서명 검증** 필수 (HMAC-SHA256, `crypto.timingSafeEqual`)
- **발신자 화이트리스트** (`user_id`)
- **채널 화이트리스트** (라우팅 테이블 = 허용 목록, 미등록 무시)
- **작업 범위 제한** — 파괴적/민감(삭제, force push, 프로덕션 직접 변경, 시크릿 노출, 결제·주문 조작) 거부. 폴링 routine의 보안 불변식 프롬프트를 그대로 이식.
- **비밀**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`(경로 B), routine 토큰(경로 A) — 전부 env, 커밋 금지.

---

## 5. 즉시 응답 패턴 (Slack 3초 제약)

- 수신 즉시 **200 ack** 반환 (작업은 백그라운드로 분리)
- Slack은 3초 무응답 시 재전송 → `event_id` 멱등으로 중복 차단
- 작업 완료 후 `chat.postMessage(thread_ts=원본)` 로 결과 회신

---

## 6. Phase / STOP gate

| Phase | 내용 | 게이트 |
|---|---|---|
| **0** | 경로 A 가능성 검증 — routine 외부 발사 공식 인증 API 존재 여부. 없으면 경로 B 확정 | 결과 보고 후 진행 |
| **1** | 허브 프로젝트 스캐폴드 + Slack 앱 + `/api/slack/events`(서명검증+ack+challenge). 단일 채널 echo 테스트 | 동작 확인 |
| **2** | 실행부(A 또는 B) + 단일 프로젝트(jullyssy) e2e 명령 처리 | e2e 통과 |
| **3** | 멱등/큐 + thread 회신 + 보안 3중(서명·발신자·채널) | 보안 검증 |
| **4** | 멀티 프로젝트 라우팅 확장(채널 추가) | — |

---

## 7. 리스크

- **R1 (경로 A 블로커)**: routine 외부 발사 인증 API 부재 가능성 → 경로 B(Agent SDK)로 폴백. **Phase 0에서 판정.**
- **R2 (실행시간)**: 경로 B 긴 작업 → Vercel Function 타임아웃. fluid compute 또는 큐+백그라운드 워커.
- **R3 (Slack 3초)**: ack 지연 시 Slack 재시도 폭주 → 즉시 200 + event_id 멱등 필수.
- **R4 (보안)**: 공개 채널 명령 노출 → 서명 + 발신자 + 채널 화이트리스트 3중 방어.

---

## 8. 기존 자산 재사용

- **폴링 routine** (`trig_01F3b24fyHFpZJbHfHumuxwt`): 경로 A면 이 routine을 run-now로 재사용. 경로 B면 **보안 불변식 프롬프트를 Agent SDK 시스템 프롬프트로 이식**.
- **`slack_command_log` 테이블** (jullyssy migration 046): 허브 멱등/감사 로그로 재사용 가능.
- **Slack 앱/커넥터**: 동일 워크스페이스, 채널만 추가 구독.

---

## 9. 미해결 질문

1. routine을 외부 HTTP에서 발사하는 **공식 인증 방법**이 있는가? (경로 A 성립 여부 — Phase 0 최우선)
2. 멀티 워크스페이스 지원 범위?
3. 명령 결과가 길 때 Slack 포맷 (코드블록 / 스레드 분할 / Canvas)?
4. 폴링 routine과 웹훅의 **공존 정책** — 둘 다 같은 채널을 보면 중복 처리? (멱등 표식 = thread 회신이라 한쪽이 먼저 회신하면 다른 쪽 skip → 자연 공존, 단 확인 필요)

---

## 10. 결정 기록 (구현 중 채움)

| # | 원가정 | 실구현 | 사유 |
|---|---|---|---|
| Phase 1 | Slack 이벤트 엔드포인트 | 서명 검증, url_verification, 즉시 ack, 단일 채널 echo stub | Slack 3초 제약과 이벤트 수신 경로 우선 검증 |
| Phase 2 | 실행부(A 또는 B) + 단일 프로젝트 e2e | Claude routine `/fire` executor로 단일 프로젝트 명령 처리, Slack thread session URL 회신 | Phase 0에서 `/fire` HTTP 엔드포인트 확인 |
| Phase 3 | 멱등/큐 + 보안 강화 | `SLACK_EXECUTOR` 기반 실행부 교체 가능 구조로 우선 변경 (`routine` 기본값, `noop` 지원) | routine 일일 한도와 향후 Agent SDK/worker 전환 리스크를 줄이기 위해 실행 백엔드 추상화를 먼저 도입 |
| Phase 4 | 멀티 프로젝트 라우팅 | `SLACK_ROUTES_JSON` 기반 채널별 route table 구현, route별 `routine`/`noop`, `tokenEnv` 지원 | 프로젝트 변경마다 Vercel env 전체를 바꾸지 않고 채널별 실행 대상을 고정하기 위함 |
