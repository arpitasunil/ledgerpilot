
-- LedgerPilot: PostgreSQL database schema
-- M1: Lead Architect & Backend
-- All eight tables include created_at.

-- 1. Vendors: vendor registry and risk flags
CREATE TABLE IF NOT EXISTS vendors (
    vendor_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_name VARCHAR(200) NOT NULL,
    email VARCHAR(255),
    risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
    risk_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Invoices: parsed invoice information
CREATE TABLE IF NOT EXISTS invoices (
    invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id BIGINT REFERENCES vendors(vendor_id),
    invoice_number VARCHAR(100) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    invoice_date DATE,
    due_date DATE,
    line_items JSONB NOT NULL DEFAULT '[]'::JSONB,
    status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN (
            'RECEIVED', 'PROCESSING', 'AWAITING_APPROVAL',
            'PAYMENT_PENDING', 'PAID', 'REJECTED', 'ESCALATED'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (vendor_id, invoice_number)
);

-- 3. Workflow runs: durable state-machine state
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id BIGINT REFERENCES invoices(invoice_id),
    current_state VARCHAR(40) NOT NULL DEFAULT 'RECEIVED'
        CHECK (current_state IN (
            'RECEIVED', 'PLANNED', 'PARSED', 'VALIDATED',
            'RISK_ASSESSED', 'AWAITING_APPROVAL',
            'PAYMENT_PENDING', 'PAYMENT_PROCESSING',
            'PAID', 'REJECTED', 'ESCALATED'
        )),
    context JSONB NOT NULL DEFAULT '{}'::JSONB,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Workflow steps: execution trace and worker output
CREATE TABLE IF NOT EXISTS workflow_steps (
    step_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES workflow_runs(run_id)
        ON DELETE CASCADE,
    step_name VARCHAR(100) NOT NULL,
    worker_name VARCHAR(100),
    step_status VARCHAR(30) NOT NULL DEFAULT 'STARTED'
        CHECK (step_status IN ('STARTED', 'COMPLETED', 'FAILED')),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0),
    output JSONB NOT NULL DEFAULT '{}'::JSONB,
    critique_notes TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 1
        CHECK (attempt_number > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Ledger entries: append-only journal and SHA-256 hash chain
CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT REFERENCES workflow_runs(run_id),
    invoice_id BIGINT REFERENCES invoices(invoice_id),
    entry_type VARCHAR(40) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    payload JSONB NOT NULL,
    prev_digest CHAR(64),
    digest CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Audit logs: record actions and actors
CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT REFERENCES workflow_runs(run_id),
    actor_type VARCHAR(20) NOT NULL
        CHECK (actor_type IN ('AGENT', 'HUMAN', 'SYSTEM')),
    actor_id VARCHAR(150),
    action VARCHAR(100) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Approval events: human-in-the-loop decisions
CREATE TABLE IF NOT EXISTS approval_events (
    approval_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES workflow_runs(run_id),
    approver VARCHAR(150) NOT NULL,
    decision VARCHAR(20) NOT NULL
        CHECK (decision IN ('APPROVE', 'REJECT')),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Email receipts: mock payment receipt previews
CREATE TABLE IF NOT EXISTS email_receipts (
    receipt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES workflow_runs(run_id),
    invoice_id BIGINT REFERENCES invoices(invoice_id),
    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    receipt_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common dashboard and workflow queries
CREATE INDEX IF NOT EXISTS idx_invoices_status
    ON invoices(status);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_state
    ON workflow_runs(current_state);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_run
    ON workflow_steps(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_run
    ON ledger_entries(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_run
    ON audit_logs(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_approval_events_run
    ON approval_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_receipts_run
    ON email_receipts(run_id);
