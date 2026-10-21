// ============================================================
// REPORTLI AI — OUTREACH TASK WORKER
// Version: 2.0.0
//
// PURPOSE:
// - Read applications and customer niches from Supabase.
// - Select the next eligible niche using buying_intention.
// - Use Sarvam AI to generate niche-specific outreach research
//   recommendations.
// - Create a provider-neutral lead research task in planner_runs.
// - Use worker_type = "cold_outreach".
// - Use source = "outreach".
// - Keep the objective consistent: find 5 relevant people.
// - Mark the selected niche Completed.
// - Rotate niches when all niches are completed.
// - Save task-generation errors in planner_runs.error.
//
// IMPORTANT:
// This worker ONLY CREATES TASKS.
// It does NOT call any lead provider.
// It does NOT retrieve leads.
// It does NOT send cold emails.
//
// REQUIRED CLOUDFLARE SECRETS:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
// DATABASE COMPATIBILITY:
// The existing customer_niches.apollo_status column is retained.
// Change the column name separately only if you also migrate
// your database schema and every worker using that column.
// ============================================================

const WORKER_TYPE = "cold_outreach";
const SOURCE = "outreach";
const TASK_COUNT = 5;
const SARVAM_MAX_ATTEMPTS = 3;

// ============================================================
// REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "outreach-task-worker",
        version: "2.0.0",
      });
    }

    if (
      request.method !== "POST" ||
      (url.pathname !== "/" && url.pathname !== "/cron")
    ) {
      return jsonResponse(
        { error: "Use POST /cron to trigger the worker." },
        405
      );
    }

    try {
      validateEnvironment(env);

      const result = await runCron(env);

      return jsonResponse({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error("Outreach Task Worker failed:", {
        code: error.code || "WORKER_ERROR",
        message: error.message,
      });

      return jsonResponse(
        {
          ok: false,
          error: error.code || "WORKER_ERROR",
          message: error.message,
        },
        500
      );
    }
  },
};

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ]) {
    if (!env[name]) {
      throw createError(
        "CONFIG_MISSING",
        `Missing Cloudflare secret: ${name}`
      );
    }
  }
}

// ============================================================
// ERROR HELPER
// ============================================================

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  let response;

  try {
    response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    throw createError(
      "SUPABASE_NETWORK_ERROR",
      `Could not connect to Supabase: ${error.message}`
    );
  }

  const bodyText = await response.text();

  if (!response.ok) {
    console.error("Supabase HTTP error:", {
      status: response.status,
      path,
      body: bodyText.slice(0, 2000),
    });

    throw createError(
      `SUPABASE_HTTP_${response.status}`,
      `Supabase returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`
    );
  }

  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

// ============================================================
// GET APPLICATIONS
// ============================================================

async function getApplications(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,user_id,company&order=created_at.asc&limit=1000"
  );

  if (!Array.isArray(rows)) {
    throw createError(
      "APPLICATIONS_INVALID_RESPONSE",
      "Supabase did not return an applications array."
    );
  }

  return rows;
}

// ============================================================
// GET LATEST OUTREACH TASK
// ============================================================

async function getLatestOutreachTask(env, applicationId) {
  const query = new URLSearchParams({
    select: "id,status",
    application_id: `eq.${applicationId}`,
    source: `eq.${SOURCE}`,
    order: "created_at.desc,id.desc",
    limit: "1",
  });

  const rows = await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ============================================================
// GET CUSTOMER NICHES
// ============================================================

async function getCustomerNiches(env, applicationId) {
  const query = new URLSearchParams({
    select:
      "id,application_id,user_id,niche_name,buying_intention,apollo_status,created_at,updated_at",
    application_id: `eq.${applicationId}`,
    order: "created_at.asc",
    limit: "1000",
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`
  );

  if (!Array.isArray(rows)) {
    throw createError(
      "NICHES_INVALID_RESPONSE",
      "Supabase did not return a customer_niches array."
    );
  }

  return rows;
}

// ============================================================
// SELECT A NICHE
//
// 1. Prefer pending niches with highest buying_intention.
// 2. If all niches are completed, select the oldest updated niche.
// 3. Rotation resets the other niches to pending after success.
// ============================================================

function selectNiche(niches) {
  if (!niches.length) {
    return { niche: null, rotation: false };
  }

  const pending = niches.filter(
    (niche) =>
      String(niche.apollo_status || "").toLowerCase() === "pending"
  );

  if (pending.length) {
    pending.sort((a, b) => {
      const score =
        Number(b.buying_intention || 0) -
        Number(a.buying_intention || 0);

      if (score !== 0) return score;

      return (
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
      );
    });

    return { niche: pending[0], rotation: false };
  }

  const allCompleted = niches.every(
    (niche) =>
      String(niche.apollo_status || "").toLowerCase() === "completed"
  );

  if (!allCompleted) {
    return { niche: null, rotation: false };
  }

  const oldestFirst = [...niches].sort((a, b) => {
    const aTime = a.updated_at
      ? new Date(a.updated_at).getTime()
      : 0;

    const bTime = b.updated_at
      ? new Date(b.updated_at).getTime()
      : 0;

    if (aTime !== bTime) return aTime - bTime;

    return (
      new Date(a.created_at || 0).getTime() -
      new Date(b.created_at || 0).getTime()
    );
  });

  return { niche: oldestFirst[0], rotation: true };
}

// ============================================================
// SARVAM API CALL
// ============================================================

async function callSarvam(env, prompt, useOptionalParams) {
  const body = {
    model: "sarvam-105b",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 6000,
  };

  if (useOptionalParams) {
    body.reasoning_effort = "low";
  }

  let response;

  try {
    response = await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": env.SARVAM_API_KEY,
        },
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    throw createError(
      "SARVAM_NETWORK_ERROR",
      `Could not connect to Sarvam: ${error.message}`
    );
  }

  const responseText = await response.text();

  console.log("Sarvam HTTP status:", response.status);

  if (!response.ok) {
    console.error(
      "Sarvam error body:",
      responseText.slice(0, 2000)
    );

    const error = createError(
      `SARVAM_HTTP_${response.status}`,
      `Sarvam returned HTTP ${response.status}.`
    );

    error.status = response.status;
    throw error;
  }

  if (!responseText.trim()) {
    return {
      content: "",
      reasoning: "",
      finishReason: "empty_body",
    };
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw createError(
      "SARVAM_INVALID_JSON",
      "Sarvam returned invalid JSON."
    );
  }

  const choice = data?.choices?.[0];
  let content = choice?.message?.content;

  if (Array.isArray(content)) {
    content = content
      .map((part) => part?.text || "")
      .join("");
  }

  if (content && typeof content === "object") {
    content = JSON.stringify(content);
  }

  return {
    content: typeof content === "string" ? content : "",
    reasoning:
      typeof choice?.message?.reasoning_content === "string"
        ? choice.message.reasoning_content
        : "",
    finishReason: choice?.finish_reason || "unknown",
  };
}

// ============================================================
// EXTRACT JSON OBJECT
// ============================================================

function extractJsonObject(text) {
  if (typeof text !== "string") return null;

  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting JSON from surrounding text.
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ============================================================
// NORMALIZE AI-GENERATED STRINGS
// ============================================================

function normalizeUniqueStrings(values) {
  if (!Array.isArray(values)) return [];

  const result = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== "string") continue;

    const cleaned = value
      .trim()
      .replace(/^[-*]\s*/, "")
      .replace(/^["']|["']$/g, "")
      .trim();

    if (!cleaned) continue;

    const key = cleaned.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

// ============================================================
// SARVAM AI — GENERATE NICHE-SPECIFIC RECOMMENDATIONS
//
// Generates:
// - Exactly 5 recommended job titles.
// - Relevant departments.
// - Relevant seniority levels.
// - Company keywords.
// - Company size.
// - Company location.
// - Company industries.
//
// Sarvam generates the task recommendations only.
// It does not search for or retrieve leads.
// ============================================================

async function generateOutreachPlan(env, company, nicheName) {
  const prompt = `
You are a B2B lead-research task planner for a SaaS platform.

COMPANY CONTEXT:
${String(company || "No company description provided").slice(0, 12000)}

CUSTOMER NICHE:
${String(nicheName || "").slice(0, 500)}

Create search recommendations for finding 5 relevant people
in the specified customer niche.

Return ONLY a valid JSON object with this structure:

{
  "job_titles": [
    "Job title 1",
    "Job title 2",
    "Job title 3",
    "Job title 4",
    "Job title 5"
  ],
  "department": "Relevant departments",
  "seniority": [
    "Seniority 1",
    "Seniority 2"
  ],
  "company_keywords": [
    "Keyword 1",
    "Keyword 2",
    "Keyword 3",
    "Keyword 4",
    "Keyword 5"
  ],
  "company_size": "1–50 employees",
  "company_location": "United States",
  "company_industry": [
    "Industry 1",
    "Industry 2"
  ]
}

RULES:

- Generate exactly 5 unique and relevant job titles.
- Adapt all recommendations to the customer niche.
- Do not use the same fixed job titles for every niche.
- Choose decision-makers who are likely to be relevant to the niche.
- Generate relevant company keywords and industries.
- Use concise, realistic search filters.
- Use company context to understand the customer's business.
- Do not invent specific companies, people, or email addresses.
- If no target location is provided in the company context,
  select one suitable country from:
  United States, United Kingdom, Canada, Australia, Germany,
  Singapore, Netherlands, India.
- Always return an actual country name for company_location.
- If company size is not specified, use 1–50 employees.
- Use relevant departments and seniority levels.
- Return JSON only, without Markdown fences or explanations.
`;

  let useOptionalParams = true;
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= SARVAM_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const result = await callSarvam(
        env,
        prompt,
        useOptionalParams
      );

      let plan = extractJsonObject(result.content);

      if (
        !plan &&
        !result.content.trim() &&
        result.reasoning
      ) {
        plan = extractJsonObject(result.reasoning);
      }

      if (!plan) {
        lastError = createError(
          result.content.trim()
            ? "SARVAM_INVALID_PLAN_JSON"
            : "SARVAM_EMPTY_CONTENT",
          `Sarvam did not return a usable outreach plan (finish_reason: ${result.finishReason}).`
        );

        console.warn("Invalid Sarvam outreach plan:", {
          attempt,
          finish_reason: result.finishReason,
          content_chars: result.content.length,
          reasoning_chars: result.reasoning.length,
        });

        if (attempt < SARVAM_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * attempt)
          );
        }

        continue;
      }

      const jobTitles = normalizeUniqueStrings(plan.job_titles);
      const companyKeywords = normalizeUniqueStrings(
        plan.company_keywords
      );
      const companyIndustry = normalizeUniqueStrings(
        plan.company_industry
      );
      const seniority = normalizeUniqueStrings(plan.seniority);

      if (
        jobTitles.length !== 5 ||
        companyKeywords.length === 0 ||
        companyIndustry.length === 0 ||
        seniority.length === 0 ||
        typeof plan.department !== "string" ||
        !plan.department.trim() ||
        typeof plan.company_size !== "string" ||
        !plan.company_size.trim() ||
        typeof plan.company_location !== "string" ||
        !plan.company_location.trim()
      ) {
        lastError = createError(
          "SARVAM_INVALID_PLAN_FIELDS",
          "Sarvam's outreach plan is missing required fields or does not contain exactly 5 unique job titles."
        );

        if (attempt < SARVAM_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * attempt)
          );
        }

        continue;
      }

      return {
        jobTitles,
        department: plan.department.trim(),
        seniority,
        companyKeywords,
        companySize: plan.company_size.trim(),
        companyLocation: plan.company_location.trim(),
        companyIndustry,
      };
    } catch (error) {
      lastError = error;

      if (error.status === 400 && useOptionalParams) {
        useOptionalParams = false;
        continue;
      }

      const transient =
        error.code === "SARVAM_NETWORK_ERROR" ||
        error.code === "SARVAM_HTTP_429" ||
        (error.status && error.status >= 500);

      if (!transient) {
        throw error;
      }

      console.warn("Transient Sarvam error:", {
        attempt,
        code: error.code,
        message: error.message,
      });

      if (attempt < SARVAM_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * attempt)
        );
      }
    }
  }

  throw (
    lastError ||
    createError(
      "SARVAM_PLAN_FAILED",
      "Sarvam failed to generate an outreach task after retries."
    )
  );
}

// ============================================================
// FORMAT PROVIDER-NEUTRAL OUTREACH TASK
//
// Objective remains the same for every niche.
// Only niche-specific recommendations change.
// Provider names are intentionally excluded.
// ============================================================

function formatTask(nicheName, plan) {
  return [
    `Customer Niche: ${nicheName}`,
    "",
    `Objective: Find ${TASK_COUNT} relevant people in the ${nicheName} niche by discovering matching companies, identifying relevant decision-makers, and retrieving their available professional email addresses.`,
    "",
    "Recommended Job Titles:",
    ...plan.jobTitles.map((title) => `- ${title}`),
    "",
    "People Search Filters:",
    "- Contact type: People.",
    `- Department: ${plan.department}, where supported.`,
    `- Seniority: ${plan.seniority.join(", ")}, where relevant.`,
    "- Email status: Prefer contacts with verified professional email addresses.",
    "",
    "Company Filters:",
    `- Company keywords: ${plan.companyKeywords.join(", ")}.`,
    `- Company size: ${plan.companySize}.`,
    `- Company location: ${plan.companyLocation}.`,
    `- Company industry: ${plan.companyIndustry.join(", ")}, where applicable.`,
    `- Business model: Relevant to ${nicheName}.`,
  ].join("\n");
}

// ============================================================
// INSERT PLANNER TASK
// ============================================================

async function insertPlannerTask(env, row) {
  return await supabaseRequest(env, "planner_runs", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
}

// ============================================================
// NICHE STATUS UPDATE — VERIFIED
//
// The existing apollo_status database column is retained
// for compatibility with your current database.
// ============================================================

async function updateNiche(
  env,
  nicheId,
  status,
  updatedAt
) {
  try {
    return await patchNiche(env, nicheId, status, updatedAt);
  } catch (error) {
    const rejected =
      /23514|check constraint|invalid input value|violates/i.test(
        String(error.message)
      );

    if (rejected && status !== status.toLowerCase()) {
      console.warn(
        `Status "${status}" rejected; retrying with lowercase.`
      );

      return await patchNiche(
        env,
        nicheId,
        status.toLowerCase(),
        updatedAt
      );
    }

    throw error;
  }
}

async function patchNiche(
  env,
  nicheId,
  status,
  updatedAt
) {
  const query = new URLSearchParams({
    id: `eq.${nicheId}`,
    select:
      "id,application_id,niche_name,apollo_status,updated_at",
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        apollo_status: status,
        updated_at: updatedAt,
      }),
    }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw createError(
      "NICHE_STATUS_UPDATE_FAILED",
      `Supabase updated zero rows for niche ID ${nicheId}.`
    );
  }

  const saved = rows[0];

  if (
    String(saved.apollo_status || "").toLowerCase() !==
    String(status).toLowerCase()
  ) {
    throw createError(
      "NICHE_STATUS_VERIFICATION_FAILED",
      `Niche ${nicheId} has status "${saved.apollo_status}", expected "${status}".`
    );
  }

  console.log(
    JSON.stringify({
      event: "niche_status_updated",
      niche_id: saved.id,
      application_id: saved.application_id,
      niche_name: saved.niche_name,
      status: saved.apollo_status,
      updated_at: saved.updated_at,
    })
  );

  return saved;
}

// ============================================================
// SAVE ERROR TO planner_runs.error
// ============================================================

async function saveFailedTask(
  env,
  application,
  niche,
  error
) {
  const errorCode = error.code || "OUTREACH_TASK_ERROR";

  const errorText =
    `${errorCode}: ${error.message || ""}`.slice(0, 500);

  const base = {
    application_id: application.id,
    user_id: application.user_id || niche?.user_id || null,
    worker_type: WORKER_TYPE,
    source: SOURCE,
    task: niche
      ? `Outreach task generation failed for customer niche: ${niche.niche_name}`
      : "Outreach task failed because no niche was selected.",
    error: errorText,
    niche: niche?.niche_name || null,
    status: "failed",
  };

  const attempts = [
    {
      ...base,
      pending_count: TASK_COUNT,
      created_at: new Date().toISOString(),
      started_at: null,
    },
    base,
  ];

  for (const row of attempts) {
    try {
      await insertPlannerTask(env, row);

      console.log(
        JSON.stringify({
          event: "failed_outreach_task_saved",
          application_id: application.id,
          niche: niche?.niche_name || null,
          error: errorCode,
        })
      );

      return;
    } catch (saveError) {
      console.error("Could not save failed task:", {
        application_id: application.id,
        original_error: errorCode,
        save_error: saveError.code,
        save_message: saveError.message,
      });
    }
  }
}

// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(env, application) {
  let selectedNiche = null;
  let plannerTaskCreated = false;

  try {
    const latestTask = await getLatestOutreachTask(
      env,
      application.id
    );

    const latestStatus = String(
      latestTask?.status || ""
    ).toLowerCase();

    if (latestStatus === "pending") {
      return {
        application_id: application.id,
        created: false,
        reason: "outreach_task_already_pending",
      };
    }

    if (
      latestTask &&
      latestStatus !== "completed" &&
      latestStatus !== "failed"
    ) {
      return {
        application_id: application.id,
        created: false,
        reason: "latest_task_status_not_eligible",
        status: latestTask.status,
      };
    }

    const niches = await getCustomerNiches(
      env,
      application.id
    );

    const selection = selectNiche(niches);
    selectedNiche = selection.niche;

    if (!selectedNiche) {
      return {
        application_id: application.id,
        created: false,
        reason: "no_pending_niche",
      };
    }

    const plan = await generateOutreachPlan(
      env,
      application.company,
      selectedNiche.niche_name
    );

    const taskText = formatTask(
      selectedNiche.niche_name,
      plan
    );

    const now = new Date().toISOString();

    const createdRows = await insertPlannerTask(env, {
      application_id: application.id,
      user_id:
        application.user_id ||
        selectedNiche.user_id ||
        null,
      worker_type: WORKER_TYPE,
      source: SOURCE,
      task: taskText,
      pending_count: TASK_COUNT,
      error: null,
      niche: selectedNiche.niche_name,
      created_at: now,
      started_at: null,
      status: "pending",
    });

    if (
      !Array.isArray(createdRows) ||
      createdRows.length === 0
    ) {
      throw createError(
        "PLANNER_TASK_INSERT_FAILED",
        "Supabase did not confirm creation of the outreach planner task."
      );
    }

    plannerTaskCreated = true;

    await updateNiche(
      env,
      selectedNiche.id,
      "Completed",
      now
    );

    if (selection.rotation) {
      const otherNiches = niches.filter(
        (niche) => niche.id !== selectedNiche.id
      );

      for (const niche of otherNiches) {
        await updateNiche(
          env,
          niche.id,
          "pending",
          now
        );
      }

      console.log(
        JSON.stringify({
          event: "niche_rotation_completed",
          application_id: application.id,
          processed_niche: selectedNiche.niche_name,
          reset_niches_to_pending: otherNiches.length,
        })
      );
    }

    return {
      application_id: application.id,
      created: true,
      niche: selectedNiche.niche_name,
      planner_run_id: createdRows[0].id,
      rotation: selection.rotation,
      niche_status_updated: true,
    };
  } catch (error) {
    console.error("Application processing failed:", {
      application_id: application.id,
      niche: selectedNiche?.niche_name || null,
      planner_task_created: plannerTaskCreated,
      code: error.code || "OUTREACH_TASK_ERROR",
      message: error.message,
    });

    // If the planner row already exists, update that row.
    // Do not create a duplicate failed task.
    if (plannerTaskCreated) {
      try {
        const latest = await getLatestOutreachTask(
          env,
          application.id
        );

        if (latest?.id) {
          const query = new URLSearchParams({
            id: `eq.${latest.id}`,
          });

          await supabaseRequest(
            env,
            `planner_runs?${query.toString()}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                error: `${error.code || "OUTREACH_TASK_ERROR"}: ${error.message}`.slice(0, 500),
                status: "failed",
              }),
            }
          );
        }
      } catch (updateError) {
        console.error(
          "Could not mark existing planner task failed:",
          updateError.message
        );
      }
    } else {
      await saveFailedTask(
        env,
        application,
        selectedNiche,
        error
      );
    }

    return {
      application_id: application.id,
      created: false,
      status: "failed",
      niche: selectedNiche?.niche_name || null,
      error: error.code || "OUTREACH_TASK_ERROR",
      message: error.message,
    };
  }
}

// ============================================================
// RUN CRON
// ============================================================

async function runCron(env) {
  const applications = await getApplications(env);

  const result = {
    applications_checked: applications.length,
    tasks_created: 0,
    applications_skipped: 0,
    failed: 0,
    details: [],
  };

  for (const application of applications) {
    const outcome = await processApplication(
      env,
      application
    );

    result.details.push(outcome);

    if (outcome.created) {
      result.tasks_created++;
    } else if (outcome.status === "failed") {
      result.failed++;
    } else {
      result.applications_skipped++;
    }

    console.log(JSON.stringify(outcome));
  }

  return result;
}

// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
          }
