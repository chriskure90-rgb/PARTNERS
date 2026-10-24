-- Lessons: Differentiation gets its own column, like the other optional
-- Lesson Planning fields (prior_instruction, subsequent_instruction,
-- materials_equipment). Every lesson version still keeps it in
-- lesson_content.form.optionalContext, which is what reopening a lesson uses.
--
-- Existing lessons keep their data; their differentiation starts out null.
-- Existing callers keep working: save_new_lesson_full's new parameter is last
-- and defaults to null, and update_lesson_version only changes the columns
-- whose keys it is given.
--
-- Apply before deploying the partners-save-lesson that sends p_differentiation
-- and the frontend that sends the differentiation field.

BEGIN;

-- 1. The column (nullable, no default: no existing row changes).
ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS differentiation text;

-- 2. New lessons: save_new_lesson_full also saves p_differentiation. Adding a
--    parameter changes the signature, so the old one is replaced (same body
--    otherwise) and its execute grants restored.
DROP FUNCTION IF EXISTS public.save_new_lesson_full(
  uuid, text, text, text, jsonb, text, text[], text[], text, integer, text, text, text, text, text, text
);

CREATE FUNCTION public.save_new_lesson_full(
  p_class_id uuid,
  p_lesson_title text,
  p_grade_level text,
  p_topic text,
  p_lesson_content jsonb,
  p_lesson_source text DEFAULT 'generated'::text,
  p_standards text[] DEFAULT NULL::text[],
  p_science_practices text[] DEFAULT NULL::text[],
  p_learning_objectives text DEFAULT NULL::text,
  p_duration integer DEFAULT NULL::integer,
  p_prior_instruction text DEFAULT NULL::text,
  p_subsequent_instruction text DEFAULT NULL::text,
  p_instructional_sequence text DEFAULT NULL::text,
  p_materials_equipment text DEFAULT NULL::text,
  p_lesson_template_path text DEFAULT NULL::text,
  p_rubric_path text DEFAULT NULL::text,
  p_differentiation text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid;
    v_lesson_id uuid;
    v_version_id uuid;
BEGIN
    -- 1. Identify the logged-in teacher
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 2. Verify class ownership
    IF NOT EXISTS (
        SELECT 1
        FROM public.classes
        WHERE class_id = p_class_id
          AND user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'Class not found or access denied';
    END IF;

    -- 3. Validate lesson information
    IF NULLIF(BTRIM(p_lesson_title), '') IS NULL
       OR NULLIF(BTRIM(p_grade_level), '') IS NULL
       OR NULLIF(BTRIM(p_topic), '') IS NULL
       OR p_lesson_content IS NULL
       OR jsonb_typeof(p_lesson_content) <> 'object'
       OR p_lesson_content = '{}'::jsonb
       OR p_lesson_source IS NULL
       OR p_lesson_source NOT IN ('generated', 'uploaded')
    THEN
        RAISE EXCEPTION 'Invalid lesson information';
    END IF;

    -- 4. Validate duration
    IF p_duration IS NOT NULL AND p_duration <= 0 THEN
        RAISE EXCEPTION 'Duration must be positive';
    END IF;

    -- 5. Save all Lesson Planning fields
    INSERT INTO public.lessons (
        user_id,
        class_id,
        lesson_source,
        lesson_title,
        grade_level,
        topic,
        standards,
        science_practices,
        learning_objectives,
        duration,
        prior_instruction,
        subsequent_instruction,
        instructional_sequence,
        materials_equipment,
        lesson_template_path,
        rubric_path,
        differentiation
    )
    VALUES (
        v_user_id,
        p_class_id,
        p_lesson_source,
        p_lesson_title,
        p_grade_level,
        p_topic,
        p_standards,
        p_science_practices,
        p_learning_objectives,
        p_duration,
        p_prior_instruction,
        p_subsequent_instruction,
        p_instructional_sequence,
        p_materials_equipment,
        p_lesson_template_path,
        p_rubric_path,
        p_differentiation
    )
    RETURNING lesson_id INTO v_lesson_id;

    -- 6. Create the initial lesson version
    INSERT INTO public.lesson_versions (
        lesson_id,
        version_number,
        lesson_content,
        created_by,
        is_current_version
    )
    VALUES (
        v_lesson_id,
        1,
        p_lesson_content,
        CASE
            WHEN p_lesson_source = 'uploaded'
                THEN 'teacher'::public.version_created_by
            ELSE 'ai'::public.version_created_by
        END,
        true
    )
    RETURNING lesson_version_id INTO v_version_id;

    -- 7. Return identifiers
    RETURN jsonb_build_object(
        'success', true,
        'lesson_id', v_lesson_id,
        'lesson_version_id', v_version_id,
        'version_number', 1
    );
END;
$function$;

-- Same execute grants as before (no PUBLIC grant).
REVOKE ALL ON FUNCTION public.save_new_lesson_full(
  uuid, text, text, text, jsonb, text, text[], text[], text, integer, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_new_lesson_full(
  uuid, text, text, text, jsonb, text, text[], text[], text, integer, text, text, text, text, text, text, text
) TO anon, authenticated, service_role;

-- 3. New versions: update_lesson_version accepts and syncs 'differentiation'
--    (same signature, so CREATE OR REPLACE keeps its grants).
CREATE OR REPLACE FUNCTION public.update_lesson_version(p_lesson_id uuid, p_lesson_content jsonb, p_created_by public.version_created_by DEFAULT 'ai_teacher'::public.version_created_by, p_lesson_fields jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid;
  v_version_number integer;
  v_version_id uuid;
BEGIN
  -- 1. Authentication
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 2. Ownership + lock the lesson (serializes concurrent updates)
  PERFORM 1 FROM public.lessons
  WHERE lesson_id = p_lesson_id AND user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lesson not found or access denied';
  END IF;

  -- 3. Validate content
  IF p_lesson_content IS NULL
     OR jsonb_typeof(p_lesson_content) <> 'object'
     OR p_lesson_content = '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid lesson content';
  END IF;

  -- 4. Validate lesson fields (only keys present are changed)
  IF p_lesson_fields IS NOT NULL THEN
    IF jsonb_typeof(p_lesson_fields) <> 'object' THEN
      RAISE EXCEPTION 'Invalid lesson fields';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_lesson_fields) AS k
      WHERE k NOT IN ('lesson_title','grade_level','topic','standards','science_practices',
                      'learning_objectives','duration','prior_instruction','subsequent_instruction',
                      'instructional_sequence','materials_equipment','lesson_template_path','rubric_path',
                      'differentiation')
    ) THEN
      RAISE EXCEPTION 'Unknown lesson field';
    END IF;
    IF (p_lesson_fields ? 'lesson_title' AND NULLIF(BTRIM(p_lesson_fields->>'lesson_title'), '') IS NULL)
       OR (p_lesson_fields ? 'grade_level' AND NULLIF(BTRIM(p_lesson_fields->>'grade_level'), '') IS NULL)
       OR (p_lesson_fields ? 'topic' AND NULLIF(BTRIM(p_lesson_fields->>'topic'), '') IS NULL) THEN
      RAISE EXCEPTION 'Title, grade level, and topic cannot be empty';
    END IF;
    IF p_lesson_fields ? 'duration'
       AND jsonb_typeof(p_lesson_fields->'duration') <> 'null'
       AND (jsonb_typeof(p_lesson_fields->'duration') <> 'number'
            OR (p_lesson_fields->>'duration')::numeric <= 0
            OR (p_lesson_fields->>'duration')::numeric <> trunc((p_lesson_fields->>'duration')::numeric)) THEN
      RAISE EXCEPTION 'Duration must be a positive whole number';
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(ARRAY['standards','science_practices']) AS f
      WHERE p_lesson_fields ? f
        AND jsonb_typeof(p_lesson_fields->f) <> 'null'
        AND (jsonb_typeof(p_lesson_fields->f) <> 'array'
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_lesson_fields->f) AS e
                        WHERE jsonb_typeof(e) <> 'string'))
    ) THEN
      RAISE EXCEPTION 'Standards and science practices must be arrays of text';
    END IF;
  END IF;

  -- 5. Next version number
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM public.lesson_versions WHERE lesson_id = p_lesson_id;

  -- 6. Previous version no longer current
  UPDATE public.lesson_versions SET is_current_version = false
  WHERE lesson_id = p_lesson_id AND is_current_version = true;

  -- 7. New version (history is never overwritten)
  INSERT INTO public.lesson_versions (lesson_id, version_number, lesson_content, created_by, is_current_version)
  VALUES (p_lesson_id, v_version_number, p_lesson_content, p_created_by, true)
  RETURNING lesson_version_id INTO v_version_id;

  -- 8. Sync lesson fields + timestamp (same transaction)
  UPDATE public.lessons AS l SET
    lesson_title           = CASE WHEN p_lesson_fields ? 'lesson_title'           THEN BTRIM(p_lesson_fields->>'lesson_title')    ELSE l.lesson_title END,
    grade_level            = CASE WHEN p_lesson_fields ? 'grade_level'            THEN BTRIM(p_lesson_fields->>'grade_level')     ELSE l.grade_level END,
    topic                  = CASE WHEN p_lesson_fields ? 'topic'                  THEN BTRIM(p_lesson_fields->>'topic')           ELSE l.topic END,
    standards              = CASE WHEN p_lesson_fields ? 'standards' THEN
                               CASE WHEN jsonb_typeof(p_lesson_fields->'standards') = 'null' THEN NULL
                                    ELSE ARRAY(SELECT jsonb_array_elements_text(p_lesson_fields->'standards')) END
                             ELSE l.standards END,
    science_practices      = CASE WHEN p_lesson_fields ? 'science_practices' THEN
                               CASE WHEN jsonb_typeof(p_lesson_fields->'science_practices') = 'null' THEN NULL
                                    ELSE ARRAY(SELECT jsonb_array_elements_text(p_lesson_fields->'science_practices')) END
                             ELSE l.science_practices END,
    learning_objectives    = CASE WHEN p_lesson_fields ? 'learning_objectives'    THEN p_lesson_fields->>'learning_objectives'    ELSE l.learning_objectives END,
    duration               = CASE WHEN p_lesson_fields ? 'duration'               THEN (p_lesson_fields->>'duration')::integer    ELSE l.duration END,
    prior_instruction      = CASE WHEN p_lesson_fields ? 'prior_instruction'      THEN p_lesson_fields->>'prior_instruction'      ELSE l.prior_instruction END,
    subsequent_instruction = CASE WHEN p_lesson_fields ? 'subsequent_instruction' THEN p_lesson_fields->>'subsequent_instruction' ELSE l.subsequent_instruction END,
    instructional_sequence = CASE WHEN p_lesson_fields ? 'instructional_sequence' THEN p_lesson_fields->>'instructional_sequence' ELSE l.instructional_sequence END,
    materials_equipment    = CASE WHEN p_lesson_fields ? 'materials_equipment'    THEN p_lesson_fields->>'materials_equipment'    ELSE l.materials_equipment END,
    lesson_template_path   = CASE WHEN p_lesson_fields ? 'lesson_template_path'   THEN p_lesson_fields->>'lesson_template_path'   ELSE l.lesson_template_path END,
    rubric_path            = CASE WHEN p_lesson_fields ? 'rubric_path'            THEN p_lesson_fields->>'rubric_path'            ELSE l.rubric_path END,
    differentiation        = CASE WHEN p_lesson_fields ? 'differentiation'        THEN p_lesson_fields->>'differentiation'        ELSE l.differentiation END,
    updated_at             = now()
  WHERE l.lesson_id = p_lesson_id;

  -- 9. Result (existing keys unchanged; one key added)
  RETURN jsonb_build_object(
    'success', true,
    'lesson_id', p_lesson_id,
    'lesson_version_id', v_version_id,
    'version_number', v_version_number,
    'is_current_version', true,
    'lesson_fields_updated', p_lesson_fields IS NOT NULL
  );
END;
$function$;

COMMIT;
