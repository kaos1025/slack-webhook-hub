# Phase 0 검증 결과 (2026-06-05)

## 경로 A 가능 — 블로커 해제
Claude routine을 외부에서 발사하는 공식 엔드포인트 존재. 경로 A 채택.
스펙이 RemoteTrigger 툴(in-session OAuth)과 /fire HTTP 엔드포인트를 혼동했음.
허브가 쓸 것은 /fire HTTP 엔드포인트.

## /fire 엔드포인트 (검증된 사실)
POST https://api.anthropic.com/v1/claude_code/routines/{trigger_id}/fire
헤더:
  Authorization: Bearer {routine별 토큰}   # API 키 아님. routine 편집→Add trigger→API→Generate token. 1회 표시.
  anthropic-beta: experimental-cc-routine-2026-04-01   # 실험적. 배포 전 현재 헤더 재확인 필수.
  anthropic-version: 2023-06-01
  Content-Type: application/json
body: {"text": "사람이 읽을 산문 형태의 컨텍스트"}   # JSON 넣지 말 것. 문자열로 읽힘.
응답: { claude_code_session_id, claude_code_session_url }
요구: Pro/Max/Team/Enterprise + Claude Code on the web 활성화. 구독 기반(API 과금 아님).

## 결정
- 실행 경로: A (routine /fire, 구독 기반)
- 남은 Phase 0: GitHub push 인증은 routine connectors에 설정 / 발신자 ID 확정
