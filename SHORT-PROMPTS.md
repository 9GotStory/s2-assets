# SHORT-PROMPTS.md — Spec Kit + Claude DEV + Codex Review

ใช้หลัง repository มี `CLAUDE.md`, `AGENTS.md`, `MASTER-PROMPT.md`, `REVIEWER.md`, `TECHNOLOGY.md`

## Claude DEV — Phase 0

```text
อ่าน CLAUDE.md, MASTER-PROMPT.md และ TECHNOLOGY.md แล้วดำเนินการ Phase 0 — Repository / Blueprint Readiness เท่านั้น ตรวจ Claude/Codex Spec Kit integrations และ repository state รายงานแล้ว STOP
```

## Claude DEV — Constitution

```text
ดำเนินการ Constitution phase เท่านั้นด้วย Spec Kit integration ที่ติดตั้งจริง ตรวจความสอดคล้องกับ Blueprint แล้วรายงาน/STOP
```

## Claude DEV — Specify

```text
เริ่ม active feature ที่ Product Owner อนุญาต อ่าน Feature Brief + canonical context ที่จำเป็น แล้วดำเนินการ Specify เท่านั้น ตรวจ spec.md รายงาน/STOP
```

## Claude DEV — Clarify

```text
ประเมิน material ambiguity/Clarification Candidates ถ้าจำเป็นให้ทำ Clarify เพียง phase เดียว ถ้าไม่จำเป็นให้รายงานว่าสามารถข้ามได้ แล้ว STOP
```

## Claude DEV — Plan

```text
ดำเนินการ Plan สำหรับ active feature เท่านั้น ใช้ spec ที่ยืนยันแล้วและ TECHNOLOGY.md เป็น selected technical baseline resolve เฉพาะ Deferred decisions ที่เกี่ยวข้อง ห้าม silent technology drift เลือก simplest sufficient design ตรวจ semantic drift/overengineering แล้ว STOP
```

## Claude DEV — Checklist

```text
ประเมินว่า Checklist เพิ่มคุณค่าต่อ requirements quality หรือไม่ ถ้าจำเป็นให้รัน Checklist เท่านั้น ถ้าไม่จำเป็นให้บอกเหตุผล แล้ว STOP
```

## Claude DEV — Tasks

```text
ดำเนินการ Tasks เท่านั้น ตรวจ dependency/order/coverage และ Phase grouping ใน tasks.md ระบุพื้นที่ implementation แรกที่พร้อม แต่ยังไม่ implement แล้ว STOP
```

## Claude DEV — Analyze

```text
ดำเนินการ Analyze แบบ read-only แล้วทำ lightweight alignment กับ Feature Brief/canonical rules รายงาน implementation readiness แล้ว STOP
```

## Codex Reviewer — Delivery Readiness

```text
ทำหน้าที่ Independent Reviewer ตาม AGENTS.md และ REVIEWER.md ตรวจ Delivery Readiness ของ active feature หลัง Analyze แบบ read-only รวม alignment กับ TECHNOLOGY.md/authorized deviation เมื่อมี technical Plan ห้ามแก้ไฟล์ ส่ง PASS / CHANGES REQUIRED / REVIEW BLOCKED แล้ว STOP
```

## Claude DEV — Select and Implement Next Safe Scope

```text
อ่าน Phase ปัจจุบันใน tasks.md และ incomplete dependency-ready tasks แล้วเลือก next safe bounded implementation scope ตาม MASTER-PROMPT.md scope อาจเป็น task เดี่ยวหรือ same-Phase batch ที่ coherent/reviewable ได้ ทำเฉพาะ scope นั้น รัน verification ครบ รายงาน READY FOR INDEPENDENT REVIEW แล้ว STOP
```

## Claude DEV — Implement Exact Batch

```text
ดำเนินการเฉพาะ T006–T009 ตาม tasks.md ตรวจว่าทั้งหมดอยู่ Phase เดียวกัน dependency พร้อม ไม่มี decision gate และ batch ยัง reviewable หากไม่ปลอดภัยให้ STOP พร้อมเหตุผล ห้ามขยาย scope หากผ่านให้ implement + verify ทั้ง batch แล้วรายงาน READY FOR INDEPENDENT REVIEW
```

## Claude DEV — Force Single Task for High Risk

```text
ดำเนินการเฉพาะ task ที่ Product Owner ระบุเพียง task เดียว ห้าม batch กับ task อื่น ทำ verification ที่เกี่ยวข้อง รายงาน READY FOR INDEPENDENT REVIEW แล้ว STOP
```

## Codex Reviewer — Review Current Implementation Scope

```text
ทำ Independent Implementation Scope Review ของ authorized scope ล่าสุดตาม REVIEWER.md แบบ read-only ตรวจทุก Task ID ใน scope, spec/plan/relevant Blueprint rules, TECHNOLOGY.md/authorized deviation, diff, interactions และ tests/verification ส่ง PASS / CHANGES REQUIRED / REVIEW BLOCKED แล้ว STOP
```

## Claude DEV — Rework Current Scope

```text
แก้เฉพาะ blocking findings จาก Independent Review ล่าสุดภายใน authorized scope เดิม ห้ามเริ่ม scope ใหม่ รัน verification ซ้ำ รายงาน READY FOR INDEPENDENT REVIEW แล้ว STOP
```

## Codex Reviewer — Re-review Current Scope

```text
Re-review authorized scope เดิมหลัง DEV แก้ findings ตรวจ affected Task IDs, regression และ batch interactions ที่เกี่ยวข้อง ส่ง verdict แล้ว STOP ห้ามแก้ไฟล์
```

## Claude DEV — Converge

```text
เมื่อทุก planned Task ID อยู่ใน implementation scopes ที่ผ่าน Independent Review แล้ว ให้รัน Converge เท่านั้น ถ้ามี required gaps ให้รายงานแต่ไม่แก้อัตโนมัติ ถ้าไม่มีให้รายงานว่าพร้อม Final Feature Review แล้ว STOP
```

## Codex Reviewer — Final Feature Review

```text
ทำ Independent Final Feature Review ตาม REVIEWER.md หลัง Converge แบบ read-only ตรวจ feature/spec/plan/tasks/implementation/tests/relevant rules และ coverage ของ accepted scopes ส่ง verdict แล้ว STOP
```

## Product Owner — Continue

หลัง Reviewer `PASS`:

```text
ดำเนินการต่อ: อ่าน Phase ปัจจุบันใน tasks.md แล้วเลือก next safe bounded implementation scope ตาม MASTER-PROMPT.md เพียง scope เดียว จากนั้น STOP เพื่อ Independent Review
```

## Fresh Session Recovery — DEV

```text
กู้สถานะจาก Git, Spec Kit integrations/artifacts, tasks.md Phase/task state, relevant Blueprint/Feature Brief และ TECHNOLOGY.md สำหรับ technical stage ระบุ current feature/stage และ recommended next action/scope หนึ่งอย่าง แล้ว STOP
```

## Blueprint Conflict

```text
หยุดงานและสรุปเป็น Blueprint Change Candidate: current statement/rule, observed problem, impact และ decision ที่ต้องการจาก Product Owner ห้ามแก้ frozen Blueprint เอง แล้ว STOP
```
