
require("dotenv").config({ path: ".env.local" });

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./src/db/pool");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APPROVAL_THRESHOLD = 500; // INR

app.use(cors());
app.use(express.json());

/* -------------------- HELPERS -------------------- */

function hashLedgerEntry(previousDigest, payload) {
  const canonical = JSON.stringify({
    prev_digest: previousDigest,
    payload: {
      run_id: String(payload.run_id),
      invoice_id: String(payload.invoice_id),
      payment_reference: payload.payment_reference,
      amount: String(payload.amount),
      currency: String(payload.currency).trim(),
      entry_type: payload.entry_type,
    },
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function recordWorkflowStep(
  runId,
  stepName,
  stepStatus,
  output = {},
  latencyMs = 0,
  client = pool
) {
  const result = await client.query(
    `INSERT INTO workflow_steps
       (run_id, step_name, worker_name, step_status, latency_ms, output)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      runId,
      stepName,
      "LedgerPilotBackend",
      stepStatus,
      Math.max(0, Math.round(latencyMs)),
      JSON.stringify(output),
    ]
  );

  return result.rows[0];
}

async function recordAudit(
  runId,
  actorType,
  action,
  details = {},
  client = pool
) {
  await client.query(
    `INSERT INTO audit_logs (run_id, actor_type, action, details)
     VALUES ($1, $2, $3, $4)`,
    [runId, actorType, action, JSON.stringify(details)]
  );
}

async function recordLedgerEntry(client, payment) {
  // Serialize ledger writes to preserve the hash-chain order.
  await client.query(
    "LOCK TABLE ledger_entries IN EXCLUSIVE MODE"
  );

  const existing = await client.query(
    `SELECT entry_id, digest
     FROM ledger_entries
     WHERE run_id = $1 AND entry_type = 'PAYMENT'
     LIMIT 1`,
    [payment.run_id]
  );

  if (existing.rows.length > 0) {
    return { created: false, ...existing.rows[0] };
  }

  const previous = await client.query(
    `SELECT digest
     FROM ledger_entries
     ORDER BY entry_id DESC
     LIMIT 1`
  );

  const previousDigest = previous.rows.length
    ? String(previous.rows[0].digest).trim()
    : "GENESIS";

  const payload = {
    run_id: String(payment.run_id),
    invoice_id: String(payment.invoice_id),
    payment_reference: payment.payment_reference,
    amount: String(payment.amount),
    currency: String(payment.currency).trim(),
    entry_type: "PAYMENT",
  };

  const digest = hashLedgerEntry(previousDigest, payload);

  const inserted = await client.query(
    `INSERT INTO ledger_entries
       (run_id, invoice_id, entry_type, amount, currency,
        payload, prev_digest, digest)
     VALUES ($1, $2, 'PAYMENT', $3, $4, $5, $6, $7)
     RETURNING entry_id, digest`,
    [
      payment.run_id,
      payment.invoice_id,
      payment.amount,
      payment.currency,
      JSON.stringify(payload),
      previousDigest,
      digest,
    ]
  );

  return { created: true, ...inserted.rows[0] };
}

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/* -------------------- HEALTH AND DATA -------------------- */

app.get("/", (req, res) => {
  res.json({
    name: "LedgerPilot",
    message: "Autonomous Vendor Invoice Processing Agent",
    demo_only: true,
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check:", error.message);
    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.get("/api/invoices", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.*, v.vendor_name, v.email AS vendor_email,
             v.risk_flag
      FROM invoices i
      LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
      ORDER BY i.created_at DESC
    `);
    res.json({ invoices: result.rows });
  } catch (error) {
    console.error("Invoices:", error.message);
    res.status(500).json({ message: "Could not load invoices." });
  }
});

app.get("/api/vendors", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM vendors ORDER BY vendor_id"
    );
    res.json({ vendors: result.rows });
  } catch (error) {
    console.error("Vendors:", error.message);
    res.status(500).json({ message: "Could not load vendors." });
  }
});

app.get("/api/invoices/columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoices'
      ORDER BY ordinal_position
    `);
    res.json({ columns: result.rows.map((r) => r.column_name) });
  } catch (error) {
    res.status(500).json({ message: "Could not load columns." });
  }
});

app.get("/api/vendors/columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vendors'
      ORDER BY ordinal_position
    `);
    res.json({ columns: result.rows.map((r) => r.column_name) });
  } catch (error) {
    res.status(500).json({ message: "Could not load columns." });
  }
});

/* -------------------- INVOICE AGENT -------------------- */

app.post("/api/agent/command", async (req, res) => {
  const command = String(req.body?.command || "").trim();
  const invoiceId = parsePositiveId(req.body?.invoice_id);

  if (!command || !invoiceId) {
    return res.status(400).json({
      message: "Provide a command and a valid invoice_id.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      `SELECT i.*, v.vendor_name, v.email AS vendor_email,
              v.risk_flag, v.risk_notes
       FROM invoices i
       LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
       WHERE i.invoice_id = $1
       FOR UPDATE OF i`,
      [invoiceId]
    );

    if (!invoiceResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found." });
    }

    const invoice = invoiceResult.rows[0];

    const runResult = await client.query(
      `INSERT INTO workflow_runs (invoice_id, current_state, context)
       VALUES ($1, 'RECEIVED', $2)
       RETURNING *`,
      [
        invoiceId,
        JSON.stringify({ command, demo_only: true }),
      ]
    );

    const run = runResult.rows[0];
    const start = Date.now();

    await recordWorkflowStep(
      run.run_id,
      "invoice_validation",
      "STARTED",
      { invoice_id: invoiceId },
      0,
      client
    );

    const errors = [];

  
const normalizedStatus = String(invoice.status || "").trim().toUpperCase();

if (["PAID", "AWAITING_APPROVAL", "PAYMENT_PENDING"].includes(normalizedStatus)) {
  errors.push(`Invoice cannot be reprocessed while its status is ${normalizedStatus}.`);
}




    if (!invoice.vendor_id || !invoice.vendor_name) {
      errors.push("Vendor not found.");
    }

    if (invoice.risk_flag) {
      errors.push("Vendor is flagged as high risk.");
    }

    if (!Number.isFinite(Number(invoice.amount)) || Number(invoice.amount) <= 0) {
      errors.push("Invoice amount must be positive.");
    }

    if (!invoice.invoice_number) {
      errors.push("Invoice number is missing.");
    }

    const duplicate = await client.query(
      `SELECT invoice_id
       FROM invoices
       WHERE vendor_id = $1
         AND invoice_number = $2
         AND invoice_id <> $3
       LIMIT 1`,
      [invoice.vendor_id, invoice.invoice_number, invoiceId]
    );

    if (duplicate.rows.length) {
      errors.push("Duplicate invoice detected.");
    }

    const passed = errors.length === 0;
    const approvalRequired =
      passed && Number(invoice.amount) > APPROVAL_THRESHOLD;

  const nextState = !passed
  ? "REJECTED"
  : approvalRequired
    ? "AWAITING_APPROVAL"
    : "PAYMENT_PENDING";
    const validation = {
      passed,
      errors,
      vendor: invoice.vendor_name,
      invoice_number: invoice.invoice_number,
      amount: invoice.amount,
      currency: String(invoice.currency).trim(),
    };

   
if (!["PAID", "AWAITING_APPROVAL", "PAYMENT_PENDING"].includes(invoice.status)) {
  await client.query(
    "UPDATE invoices SET status = $1 WHERE invoice_id = $2",
    [
      nextState === "AWAITING_APPROVAL"
        ? "AWAITING_APPROVAL"
        : nextState === "REJECTED"
          ? "REJECTED"
          : "PAYMENT_PENDING",
      invoiceId,
    ]
  );
}


    

    await recordWorkflowStep(
      run.run_id,
      "invoice_validation",
      "COMPLETED",
      validation,
      Date.now() - start,
      client
    );

    await recordAudit(
      run.run_id,
      "AGENT",
      "INVOICE_VALIDATED",
      { validation, next_state: nextState },
      client
    );
await client.query(
  `UPDATE workflow_runs
   SET current_state = $1,
       context = context || $2::jsonb,
       updated_at = NOW()
   WHERE run_id = $3`,
  [
    nextState,
    JSON.stringify({ validation, approval_required: approvalRequired }),
    run.run_id,
  ]
);
    await client.query("COMMIT");

    return res.json({
      message: passed
        ? approvalRequired
          ? "Invoice validated; human approval required."
          : "Invoice validated."
        : "Invoice rejected by validation.",
      run_id: run.run_id,
      invoice,
      validation,
      approval_required: approvalRequired,
      current_state: nextState,
      demo_only: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Agent command:", error.message);
    return res.status(500).json({
      message: "Could not process the invoice command.",
    });
  } finally {
    client.release();
  }
});

/* -------------------- WORKFLOW TRACE -------------------- */

app.get("/api/runs/:id/trace", async (req, res) => {
  const runId = parsePositiveId(req.params.id);

  if (!runId) {
    return res.status(400).json({ message: "Invalid run ID." });
  }

  try {
    const runResult = await pool.query(
      `SELECT wr.*, i.invoice_number, i.amount, i.currency
       FROM workflow_runs wr
       LEFT JOIN invoices i ON i.invoice_id = wr.invoice_id
       WHERE wr.run_id = $1`,
      [runId]
    );

    if (!runResult.rows.length) {
      return res.status(404).json({ message: "Workflow run not found." });
    }

    const steps = await pool.query(
      `SELECT *
       FROM workflow_steps
       WHERE run_id = $1
       ORDER BY step_id`,
      [runId]
    );

    res.json({ run: runResult.rows[0], steps: steps.rows });
  } catch (error) {
    console.error("Workflow trace:", error.message);
    res.status(500).json({ message: "Could not load workflow trace." });
  }
});

/* -------------------- HUMAN APPROVAL -------------------- */

app.post("/api/approvals/:runId", async (req, res) => {
  const runId = parsePositiveId(req.params.runId);
  const decision = String(req.body?.decision || "APPROVE").toUpperCase();
  const reason = String(req.body?.reason || "").trim();
  const approver = String(req.body?.approver || "Demo Approver").trim();

  if (!runId || !["APPROVE", "REJECT"].includes(decision)) {
    return res.status(400).json({
      message: "Provide a valid run ID and APPROVE or REJECT decision.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT wr.*, i.invoice_id AS linked_invoice_id
       FROM workflow_runs wr
       JOIN invoices i ON i.invoice_id = wr.invoice_id
       WHERE wr.run_id = $1
       FOR UPDATE OF wr`,
      [runId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Workflow run not found." });
    }

    const run = result.rows[0];

    if (run.current_state !== "AWAITING_APPROVAL") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "This workflow is not awaiting approval.",
        current_state: run.current_state,
      });
    }

    const nextState = decision === "APPROVE" ? "PAYMENT_PENDING" : "REJECTED";

    await client.query(
      `UPDATE workflow_runs
       SET current_state = $1,
           context = context || $2::jsonb,
           updated_at = NOW()
       WHERE run_id = $3`,
      [
        nextState,
        JSON.stringify({
          approved: decision === "APPROVE",
          approval_decision: decision,
          approval_reason: reason,
          approver,
        }),
        runId,
      ]
    );

    await client.query(
      "UPDATE invoices SET status = $1 WHERE invoice_id = $2",
      [nextState === "REJECTED" ? "REJECTED" : "PAYMENT_PENDING", run.invoice_id]
    );

    await client.query(
      `INSERT INTO approval_events (run_id, approver, decision, reason)
       VALUES ($1, $2, $3, $4)`,
      [runId, approver, decision, reason || null]
    );

    await recordWorkflowStep(
      runId,
      "human_approval",
      "COMPLETED",
      { decision, reason, approver, next_state: nextState },
      0,
      client
    );

    await recordAudit(
      runId,
      "HUMAN",
      `INVOICE_${decision}D`,
      { reason, approver },
      client
    );

    await client.query("COMMIT");

    res.json({
      message: `Invoice ${decision.toLowerCase()}d.`,
      run_id: runId,
      current_state: nextState,
      demo_only: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Approval:", error.message);
    res.status(500).json({ message: "Could not record approval." });
  } finally {
    client.release();
  }
});

/* -------------------- MOCK PAYMENT -------------------- */

app.post("/mock/payments", async (req, res) => {
  const runId = parsePositiveId(req.body?.run_id);

  if (!runId) {
    return res.status(400).json({ message: "A valid run_id is required." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT wr.run_id, wr.invoice_id, wr.current_state, wr.context,
              i.invoice_number, i.amount, i.currency, i.vendor_id, i.status AS invoice_status,
              v.email AS vendor_email
       FROM workflow_runs wr
       JOIN invoices i ON i.invoice_id = wr.invoice_id
       LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
       WHERE wr.run_id = $1
       FOR UPDATE OF wr`,
      [runId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Workflow run not found." });
    }

    const run = result.rows[0];

    if (run.current_state !== "PAYMENT_PENDING") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Payment requires an approved, pending workflow.",
        current_state: run.current_state,
      });
    }

    if (run.context?.payment_status === "SUCCESS") {
  await client.query("ROLLBACK");
  return res.status(409).json({
    message: "Payment has already been processed for this workflow.",
    payment_reference: run.context.payment_reference,
  });
}
if (run.invoice_status === "PAID") {
  await client.query("ROLLBACK");
  return res.status(409).json({
    message: "This invoice has already been paid. Duplicate payment blocked.",
    invoice_number: run.invoice_number,
  });
}
    // Simulate gateway latency, capped at 5 seconds.
    const requestedLatency = Number(req.body?.latencyMs ?? 0);
    const latencyMs = Number.isFinite(requestedLatency)
      ? Math.min(5000, Math.max(0, requestedLatency))
      : 0;

    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    // Simulate a gateway failure without changing payment records.
   if (req.body?.forceFail === true || String(req.body?.forceFail).toLowerCase() === "true") {
      await client.query("ROLLBACK");
      return res.status(502).json({
        message: "Mock payment gateway failure. No payment was processed.",
        run_id: runId,
        simulated_failure: true,
        latency_ms: latencyMs,
      });
    }
    const paymentReference = `DEMO-PAY-${run.run_id}`;

    await client.query(
      `UPDATE workflow_runs
       SET current_state = 'PAID',
           context = context || $1::jsonb,
           updated_at = NOW()
       WHERE run_id = $2`,
      [
        JSON.stringify({
          payment_reference: paymentReference,
          payment_status: "SUCCESS",
        }),
        runId,
      ]
    );

    await client.query(
      "UPDATE invoices SET status = 'PAID' WHERE invoice_id = $1",
      [run.invoice_id]
    );

    const ledgerEntry = await recordLedgerEntry(client, {
      run_id: run.run_id,
      invoice_id: run.invoice_id,
      payment_reference: paymentReference,
      amount: run.amount,
      currency: String(run.currency).trim(),
    });

    await recordWorkflowStep(
      runId,
      "mock_payment",
      "COMPLETED",
      { payment_reference: paymentReference, status: "SUCCESS" },
      0,
      client
    );

    await recordAudit(
      runId,
      "SYSTEM",
      "MOCK_PAYMENT_SUCCEEDED",
      { payment_reference: paymentReference, ledger_entry: ledgerEntry },
      client
    );

    if (run.vendor_email) {
      await client.query(
        `INSERT INTO email_receipts
           (run_id, invoice_id, recipient_email, subject, body, receipt_data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          runId,
          run.invoice_id,
          run.vendor_email,
          `Payment receipt: ${run.invoice_number}`,
          `Demo payment ${paymentReference} for ${run.currency} ${run.amount} was processed successfully. This is a simulated payment.`,
          JSON.stringify({
            payment_reference: paymentReference,
            amount: String(run.amount),
            currency: String(run.currency).trim(),
            demo_only: true,
          }),
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "Mock payment processed successfully.",
      run_id: runId,
      invoice_number: run.invoice_number,
      payment_reference: paymentReference,
      amount: String(run.amount),
      currency: String(run.currency).trim(),
      current_state: "PAID",
      ledger_entry: ledgerEntry,
      demo_only: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Mock payment:", error.message);
    res.status(500).json({ message: "Could not process mock payment." });
  } finally {
    client.release();
  }
});

/* -------------------- LEDGER -------------------- */

app.get("/api/ledger", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT entry_id, run_id, invoice_id, entry_type, amount,
             currency, payload, prev_digest, digest, created_at
      FROM ledger_entries
      ORDER BY entry_id ASC
    `);

    res.json({ ledger: result.rows });
  } catch (error) {
    console.error("Ledger:", error.message);
    res.status(500).json({ message: "Could not load ledger." });
  }
});

app.post("/api/ledger/verify", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT entry_id, run_id, invoice_id, entry_type, amount,
             currency, payload, prev_digest, digest
      FROM ledger_entries
      ORDER BY entry_id ASC
    `);

    let expectedPrevious = "GENESIS";

    for (const row of result.rows) {
      const payload = row.payload;

      const expectedDigest = hashLedgerEntry(expectedPrevious, {
        run_id: payload.run_id,
        invoice_id: payload.invoice_id,
        payment_reference: payload.payment_reference,
        amount: payload.amount,
        currency: payload.currency,
        entry_type: payload.entry_type,
      });

      const previousMatches =
        String(row.prev_digest || "").trim() === expectedPrevious;
      const digestMatches =
        String(row.digest || "").trim() === expectedDigest;

      if (!previousMatches || !digestMatches) {
        return res.json({
          valid: false,
          invalid_entry_id: row.entry_id,
          previous_digest_matches: previousMatches,
          digest_matches: digestMatches,
          message: "Ledger hash verification failed.",
        });
      }

      expectedPrevious = String(row.digest).trim();
    }

    return res.json({
      valid: true,
      entries_checked: result.rows.length,
      message: "Ledger hash chain is valid.",
    });
  } catch (error) {
    console.error("Ledger verification:", error.message);
    return res.status(500).json({
      message: "Could not verify ledger.",
    });
  }
});

/* Record a payment that succeeded before ledger recording was added. */
app.post("/api/ledger/backfill-paid/:runId", async (req, res) => {
  const runId = parsePositiveId(req.params.runId);

  if (!runId) {
    return res.status(400).json({ message: "A valid run ID is required." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT wr.run_id, wr.invoice_id, wr.current_state, wr.context,
              i.invoice_number, i.amount, i.currency
       FROM workflow_runs wr
       JOIN invoices i ON i.invoice_id = wr.invoice_id
       WHERE wr.run_id = $1
       FOR UPDATE OF wr`,
      [runId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Workflow run not found." });
    }

    const run = result.rows[0];
    const paymentReference = run.context?.payment_reference;

    if (
      run.current_state !== "PAID" ||
      run.context?.payment_status !== "SUCCESS" ||
      !paymentReference
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Only a previously successful payment can be recorded.",
      });
    }

    const ledgerEntry = await recordLedgerEntry(client, {
      run_id: run.run_id,
      invoice_id: run.invoice_id,
      payment_reference: paymentReference,
      amount: run.amount,
      currency: String(run.currency).trim(),
    });

    await client.query("COMMIT");

    res.json({
      message: "Existing payment recorded in the ledger.",
      invoice_number: run.invoice_number,
      payment_reference: paymentReference,
      ledger_entry: ledgerEntry,
      demo_only: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Ledger backfill:", error.message);
    res.status(500).json({ message: "Could not record the ledger entry." });
  } finally {
    client.release();
  }
});

/* -------------------- START SERVER -------------------- */

const server = app.listen(PORT, () => {
  console.log(`LedgerPilot API running on port ${PORT}`);
  console.log("Server file:", __filename);
  console.log(
    "Registered routes:",
    app.router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path)
  );
});

server.on("error", (error) => {
  console.error("Server startup error:", error.message);
});
