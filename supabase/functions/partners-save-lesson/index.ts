
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // Handle browser CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Helper: include CORS headers in every JSON response
  const jsonResponse = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: corsHeaders,
    });

  try {
    if (req.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed" },
        405
      );
    }

    // 1. Verify teacher authentication
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(
        { error: "Teacher login required" },
        401
      );
    }

    const token = authorization.slice(7);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: {
            Authorization: authorization,
          },
        },
      }
    );

    const { data: userData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !userData.user) {
      return jsonResponse(
        { error: "Invalid login session" },
        401
      );
    }

    // 2. Receive full lesson information
    const body = await req.json();

    const {
      class_id,
      lesson_title,
      grade_level,
      topic,
      lesson_content,
      lesson_source = "generated",
      standards = null,
      science_practices = null,
      learning_objectives = null,
      duration = null,
      prior_instruction = null,
      subsequent_instruction = null,
      instructional_sequence = null,
      materials_equipment = null,
      lesson_template_path = null,
      rubric_path = null,
      differentiation = null,
    } = body;

    // 3. Validate required information
    if (
      !class_id ||
      typeof lesson_title !== "string" ||
      !lesson_title.trim() ||
      typeof grade_level !== "string" ||
      !grade_level.trim() ||
      typeof topic !== "string" ||
      !topic.trim() ||
      !lesson_content ||
      typeof lesson_content !== "object" ||
      Array.isArray(lesson_content) ||
      Object.keys(lesson_content).length === 0 ||
      !["generated", "uploaded"].includes(lesson_source) ||
      (standards !== null &&
        (!Array.isArray(standards) ||
          !standards.every(
            (value: unknown) => typeof value === "string"
          ))) ||
      (science_practices !== null &&
        (!Array.isArray(science_practices) ||
          !science_practices.every(
            (value: unknown) => typeof value === "string"
          ))) ||
      (duration !== null &&
        (!Number.isInteger(duration) || duration <= 0)) ||
      (differentiation !== null && typeof differentiation !== "string")
    ) {
      return jsonResponse(
        { error: "Invalid lesson data" },
        400
      );
    }

    // 4. Save full lesson information
    const { data, error } = await supabase.rpc(
      "save_new_lesson_full",
      {
        p_class_id: class_id,
        p_lesson_title: lesson_title,
        p_grade_level: grade_level,
        p_topic: topic,
        p_lesson_content: lesson_content,
        p_lesson_source: lesson_source,
        p_standards: standards,
        p_science_practices: science_practices,
        p_learning_objectives: learning_objectives,
        p_duration: duration,
        p_prior_instruction: prior_instruction,
        p_subsequent_instruction: subsequent_instruction,
        p_instructional_sequence: instructional_sequence,
        p_materials_equipment: materials_equipment,
        p_lesson_template_path: lesson_template_path,
        p_rubric_path: rubric_path,
        p_differentiation: differentiation,
      }
    );

    if (error) {
      console.error("Lesson save failed:", error.message);

      return jsonResponse(
        { error: "Unable to save lesson" },
        400
      );
    }

    // 5. Return saved lesson IDs
    return jsonResponse(data, 201);

  } catch (error) {
    console.error("API error:", error);

    return jsonResponse(
      { error: "Request failed" },
      500
    );
  }
});
