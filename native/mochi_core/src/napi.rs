//! Zero-dependency Node.js N-API bindings for Mochi Core.
//! Allows Node.js (v18, v20, v22+) and Bun to load and execute Rust functions in-process with 0 overhead.

use std::ffi::CString;
use std::os::raw::c_char;
use std::path::Path;

use crate::{budget, diff, fuzzy, git, planner, search, stream, symbol_analyzer, tokens, tokenizer};

pub type NapiEnv = *mut std::ffi::c_void;
pub type NapiValue = *mut std::ffi::c_void;
pub type NapiCallbackInfo = *mut std::ffi::c_void;
pub type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

#[allow(non_camel_case_types)]
#[allow(dead_code)]
extern "C" {
    fn napi_create_function(
        env: NapiEnv,
        utf8name: *const c_char,
        length: usize,
        cb: NapiCallback,
        data: *mut std::ffi::c_void,
        result: *mut NapiValue,
    ) -> i32;

    fn napi_set_named_property(
        env: NapiEnv,
        object: NapiValue,
        utf8name: *const c_char,
        value: NapiValue,
    ) -> i32;

    fn napi_get_cb_info(
        env: NapiEnv,
        cbinfo: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut std::ffi::c_void,
    ) -> i32;

    fn napi_get_value_string_utf8(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> i32;

    fn napi_create_string_utf8(
        env: NapiEnv,
        str: *const c_char,
        length: usize,
        result: *mut NapiValue,
    ) -> i32;

    fn napi_create_int32(env: NapiEnv, value: i32, result: *mut NapiValue) -> i32;
    fn napi_create_int64(env: NapiEnv, value: i64, result: *mut NapiValue) -> i32;
    fn napi_create_bigint_uint64(env: NapiEnv, value: u64, result: *mut NapiValue) -> i32;
    fn napi_create_double(env: NapiEnv, value: f64, result: *mut NapiValue) -> i32;
    fn napi_create_object(env: NapiEnv, result: *mut NapiValue) -> i32;
    fn napi_get_null(env: NapiEnv, result: *mut NapiValue) -> i32;
    fn napi_get_value_int64(env: NapiEnv, value: NapiValue, result: *mut i64) -> i32;
}

unsafe fn get_string_arg(env: NapiEnv, val: NapiValue) -> Option<String> {
    let mut len = 0;
    napi_get_value_string_utf8(env, val, std::ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len + 1];
    let mut copied = 0;
    napi_get_value_string_utf8(env, val, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut copied);
    String::from_utf8(buf[..copied].to_vec()).ok()
}

unsafe fn get_int64_arg(env: NapiEnv, val: NapiValue) -> i64 {
    let mut res = 0;
    napi_get_value_int64(env, val, &mut res);
    res
}

unsafe extern "C" fn js_fuzzy_match(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 2;
    let mut argv = [std::ptr::null_mut(); 2];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 2 {
        return null_val;
    }

    let Some(text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let Some(needle) = get_string_arg(env, argv[1]) else {
        return null_val;
    };

    if let Some((start, end)) = fuzzy::fuzzy_find_unique(&text, &needle) {
        let mut obj = std::ptr::null_mut();
        napi_create_object(env, &mut obj);

        let mut start_val = std::ptr::null_mut();
        napi_create_int64(env, start as i64, &mut start_val);
        let start_key = CString::new("start").unwrap();
        napi_set_named_property(env, obj, start_key.as_ptr(), start_val);

        let mut end_val = std::ptr::null_mut();
        napi_create_int64(env, end as i64, &mut end_val);
        let end_key = CString::new("end").unwrap();
        napi_set_named_property(env, obj, end_key.as_ptr(), end_val);

        obj
    } else {
        null_val
    }
}

unsafe extern "C" fn js_git_branch(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }

    let Some(dir) = get_string_arg(env, argv[0]) else {
        return null_val;
    };

    if let Some(branch) = git::fast_git_branch(Path::new(&dir)) {
        let c_str = CString::new(branch).unwrap();
        let mut str_val = std::ptr::null_mut();
        napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
        str_val
    } else {
        null_val
    }
}

unsafe extern "C" fn js_search(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 4;
    let mut argv = [std::ptr::null_mut(); 4];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 2 {
        return null_val;
    }

    let Some(dir) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let Some(query) = get_string_arg(env, argv[1]) else {
        return null_val;
    };
    let glob = if argc > 2 { get_string_arg(env, argv[2]).unwrap_or_default() } else { String::new() };
    let limit = if argc > 3 { get_int64_arg(env, argv[3]) as usize } else { 60 };

    let res = search::search_directory(Path::new(&dir), &query, &glob, limit);
    if !res.is_empty() {
        let c_str = CString::new(res).unwrap();
        let mut str_val = std::ptr::null_mut();
        napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
        str_val
    } else {
        null_val
    }
}

unsafe extern "C" fn js_strip_think_tags(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }

    let Some(text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };

    let stripped = stream::strip_think_tags_native(&text);
    let c_str = CString::new(stripped).unwrap();
    let mut str_val = std::ptr::null_mut();
    napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
    str_val
}

unsafe extern "C" fn js_estimate_cost(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 4;
    let mut argv = [std::ptr::null_mut(); 4];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let model = if argc > 0 { get_string_arg(env, argv[0]).unwrap_or_else(|| "default".to_string()) } else { "default".to_string() };
    let prompt_tokens = if argc > 1 { get_int64_arg(env, argv[1]) as u64 } else { 0 };
    let completion_tokens = if argc > 2 { get_int64_arg(env, argv[2]) as u64 } else { 0 };
    let cache_tokens = if argc > 3 { get_int64_arg(env, argv[3]) as u64 } else { 0 };

    let tracker = budget::BudgetTracker::default();
    let cost = tracker.estimate_cost(&model, prompt_tokens, completion_tokens, cache_tokens);

    let mut res_val = std::ptr::null_mut();
    napi_create_double(env, cost, &mut res_val);
    res_val
}

unsafe extern "C" fn js_diff_numstat(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }

    let Some(output) = get_string_arg(env, argv[0]) else {
        return null_val;
    };

    let stats = diff::parse_diff_numstat(&output);
    let mut obj = std::ptr::null_mut();
    napi_create_object(env, &mut obj);

    let mut files_val = std::ptr::null_mut();
    napi_create_int64(env, stats.files as i64, &mut files_val);
    let files_key = CString::new("files").unwrap();
    napi_set_named_property(env, obj, files_key.as_ptr(), files_val);

    let mut add_val = std::ptr::null_mut();
    napi_create_int64(env, stats.additions as i64, &mut add_val);
    let add_key = CString::new("additions").unwrap();
    napi_set_named_property(env, obj, add_key.as_ptr(), add_val);

    let mut del_val = std::ptr::null_mut();
    napi_create_int64(env, stats.deletions as i64, &mut del_val);
    let del_key = CString::new("deletions").unwrap();
    napi_set_named_property(env, obj, del_key.as_ptr(), del_val);

    obj
}

unsafe extern "C" fn js_classify_prompt(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }

    let Some(prompt) = get_string_arg(env, argv[0]) else {
        return null_val;
    };

    let kind_str = match planner::PlanEngine::classify_prompt(&prompt) {
        planner::TaskKind::CodeEdit => "code-edit",
        planner::TaskKind::Investigation => "investigation",
        planner::TaskKind::Testing => "testing",
        planner::TaskKind::Refactor => "refactor",
        planner::TaskKind::Architecture => "architecture",
        planner::TaskKind::OneShotAnswer => "one-shot-answer",
    };

    let c_str = CString::new(kind_str).unwrap();
    let mut str_val = std::ptr::null_mut();
    napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
    str_val
}

unsafe extern "C" fn js_hash_prompt(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }

    let Some(text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };

    let hash = tokens::fnv1a_64_hash(text.as_bytes());
    let mut val = std::ptr::null_mut();
    napi_create_bigint_uint64(env, hash, &mut val);
    val
}

unsafe extern "C" fn js_count_tokens(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 1;
    let mut argv = [std::ptr::null_mut(); 1];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }
    let Some(text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let tok = tokenizer::BpeTokenizer::new();
    let mut val = std::ptr::null_mut();
    napi_create_int64(env, tok.count_tokens(&text) as i64, &mut val);
    val
}

unsafe extern "C" fn js_truncate_to_tokens(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 2;
    let mut argv = [std::ptr::null_mut(); 2];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 2 {
        return null_val;
    }
    let Some(text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let max_tokens = get_int64_arg(env, argv[1]).max(0) as usize;
    if max_tokens == 0 {
        return null_val;
    }
    let tok = tokenizer::BpeTokenizer::new();
    let truncated = tok.truncate_to_tokens(&text, max_tokens);
    let c_str = CString::new(truncated).unwrap();
    let mut str_val = std::ptr::null_mut();
    napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
    str_val
}

unsafe extern "C" fn js_unified_diff(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 4;
    let mut argv = [std::ptr::null_mut(); 4];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 2 {
        return null_val;
    }
    let Some(old_text) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let Some(new_text) = get_string_arg(env, argv[1]) else {
        return null_val;
    };
    let old_file = if argc >= 3 { get_string_arg(env, argv[2]).unwrap_or_else(|| "a/file".to_string()) } else { "a/file".to_string() };
    let new_file = if argc >= 4 { get_string_arg(env, argv[3]).unwrap_or_else(|| "b/file".to_string()) } else { "b/file".to_string() };

    let diff_text = diff::generate_unified_diff(&old_text, &new_text, &old_file, &new_file);
    let c_str = CString::new(diff_text).unwrap();
    let mut str_val = std::ptr::null_mut();
    napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
    str_val
}

unsafe extern "C" fn js_skeletonize_source(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let mut argc = 2;
    let mut argv = [std::ptr::null_mut(); 2];
    napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());

    let mut null_val = std::ptr::null_mut();
    napi_get_null(env, &mut null_val);

    if argc < 1 {
        return null_val;
    }
    let Some(source) = get_string_arg(env, argv[0]) else {
        return null_val;
    };
    let ext = if argc >= 2 { get_string_arg(env, argv[1]).unwrap_or_else(|| "ts".to_string()) } else { "ts".to_string() };

    let skeleton = symbol_analyzer::skeletonize_source(&source, &ext);
    let c_str = CString::new(skeleton).unwrap();
    let mut str_val = std::ptr::null_mut();
    napi_create_string_utf8(env, c_str.as_ptr(), c_str.as_bytes().len(), &mut str_val);
    str_val
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let funcs: &[(&str, NapiCallback)] = &[
        ("fuzzyMatch", js_fuzzy_match),
        ("gitBranch", js_git_branch),
        ("searchDir", js_search),
        ("stripThinkTags", js_strip_think_tags),
        ("hashPrompt", js_hash_prompt),
        ("estimateCost", js_estimate_cost),
        ("diffNumstat", js_diff_numstat),
        ("classifyPrompt", js_classify_prompt),
        ("countTokens", js_count_tokens),
        ("truncateToTokens", js_truncate_to_tokens),
        ("unifiedDiff", js_unified_diff),
        ("skeletonizeSource", js_skeletonize_source),
    ];

    for &(name, cb) in funcs {
        let mut fn_val = std::ptr::null_mut();
        let c_name = CString::new(name).unwrap();
        napi_create_function(
            env,
            c_name.as_ptr(),
            c_name.as_bytes().len(),
            cb,
            std::ptr::null_mut(),
            &mut fn_val,
        );
        napi_set_named_property(env, exports, c_name.as_ptr(), fn_val);
    }

    exports
}
