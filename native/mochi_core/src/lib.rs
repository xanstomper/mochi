//! Mochi Core Native Rust Engine
//! High-performance native hot-paths for agent loop, fuzzy matching, search, git detection, outline extraction, streaming, and data handling.

pub mod acp;
pub mod agent_loop;
pub mod autopsy;
pub mod budget;
pub mod codegraph;
pub mod context;
pub mod daemon;
pub mod diff;
pub mod fuzzy;
pub mod git;
pub mod kv_cache;
pub mod planner;
pub mod repo;
pub mod search;
pub mod skills;
pub mod stream;
pub mod tokens;
pub mod tui_state;
pub mod verification;

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::slice;

pub use acp::*;
pub use agent_loop::*;
pub use autopsy::*;
pub use budget::*;
pub use codegraph::*;
pub use context::*;
pub use daemon::*;
pub use diff::*;
pub use fuzzy::*;
pub use git::*;
pub use kv_cache::*;
pub use planner::*;
pub use repo::*;
pub use search::*;
pub use skills::*;
pub use stream::*;
pub use tokens::*;
pub use tui_state::*;
pub use verification::*;

// ============================================================================
// C-ABI FFI Exports (Callable from Node & Bun in-process)
// ============================================================================

#[no_mangle]
pub unsafe extern "C" fn mochi_fuzzy_match(
    text_ptr: *const c_char,
    needle_ptr: *const c_char,
    out_start: *mut usize,
    out_end: *mut usize,
) -> c_int {
    if text_ptr.is_null() || needle_ptr.is_null() || out_start.is_null() || out_end.is_null() {
        return -1;
    }
    let Ok(text) = (unsafe { CStr::from_ptr(text_ptr) }).to_str() else {
        return -1;
    };
    let Ok(needle) = (unsafe { CStr::from_ptr(needle_ptr) }).to_str() else {
        return -1;
    };

    if let Some((start, end)) = fuzzy::fuzzy_find_unique(text, needle) {
        unsafe {
            *out_start = start;
            *out_end = end;
        }
        1 // Matched uniquely
    } else {
        0 // No match or ambiguous
    }
}

#[no_mangle]
pub unsafe extern "C" fn mochi_git_branch(
    dir_ptr: *const c_char,
    out_buf: *mut c_char,
    out_cap: usize,
) -> c_int {
    if dir_ptr.is_null() || out_buf.is_null() || out_cap == 0 {
        return -1;
    }
    let Ok(dir_str) = (unsafe { CStr::from_ptr(dir_ptr) }).to_str() else {
        return -1;
    };
    let p = Path::new(dir_str);

    if let Some(branch) = git::fast_git_branch(p) {
        if let Ok(c_branch) = CString::new(branch) {
            let bytes = c_branch.as_bytes_with_nul();
            if bytes.len() <= out_cap {
                let dst = unsafe { slice::from_raw_parts_mut(out_buf as *mut u8, bytes.len()) };
                dst.copy_from_slice(bytes);
                return (bytes.len() - 1) as c_int;
            }
        }
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn mochi_search(
    dir_ptr: *const c_char,
    query_ptr: *const c_char,
    glob_ptr: *const c_char,
    limit: usize,
    out_buf: *mut c_char,
    out_cap: usize,
) -> c_int {
    if dir_ptr.is_null() || query_ptr.is_null() || out_buf.is_null() || out_cap == 0 {
        return -1;
    }
    let Ok(dir_str) = (unsafe { CStr::from_ptr(dir_ptr) }).to_str() else {
        return -1;
    };
    let Ok(query_str) = (unsafe { CStr::from_ptr(query_ptr) }).to_str() else {
        return -1;
    };
    let glob_str = if glob_ptr.is_null() {
        ""
    } else {
        (unsafe { CStr::from_ptr(glob_ptr) }).to_str().unwrap_or("")
    };

    let result = search::search_directory(Path::new(dir_str), query_str, glob_str, limit);
    if let Ok(c_res) = CString::new(result) {
        let bytes = c_res.as_bytes_with_nul();
        let copy_len = bytes.len().min(out_cap);
        let dst = unsafe { slice::from_raw_parts_mut(out_buf as *mut u8, copy_len) };
        dst.copy_from_slice(&bytes[..copy_len]);
        if copy_len > 0 {
            dst[copy_len - 1] = 0; // Null terminate
        }
        return (copy_len - 1) as c_int;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn mochi_strip_think_tags(
    text_ptr: *const c_char,
    out_buf: *mut c_char,
    out_cap: usize,
) -> c_int {
    if text_ptr.is_null() || out_buf.is_null() || out_cap == 0 {
        return -1;
    }
    let Ok(text) = (unsafe { CStr::from_ptr(text_ptr) }).to_str() else {
        return -1;
    };

    let stripped = stream::strip_think_tags_native(text);
    if let Ok(c_res) = CString::new(stripped) {
        let bytes = c_res.as_bytes_with_nul();
        let copy_len = bytes.len().min(out_cap);
        let dst = unsafe { slice::from_raw_parts_mut(out_buf as *mut u8, copy_len) };
        dst.copy_from_slice(&bytes[..copy_len]);
        if copy_len > 0 {
            dst[copy_len - 1] = 0;
        }
        return (copy_len - 1) as c_int;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn mochi_hash_prompt(
    data_ptr: *const u8,
    data_len: usize,
) -> u64 {
    if data_ptr.is_null() || data_len == 0 {
        return 0;
    }
    let slice = unsafe { slice::from_raw_parts(data_ptr, data_len) };
    tokens::fnv1a_64_hash(slice)
}

#[no_mangle]
pub unsafe extern "C" fn mochi_estimate_cost_usd(
    model_ptr: *const c_char,
    prompt_tokens: u64,
    completion_tokens: u64,
    cache_read_tokens: u64,
) -> f64 {
    let model = if model_ptr.is_null() {
        "default"
    } else {
        (unsafe { CStr::from_ptr(model_ptr) }).to_str().unwrap_or("default")
    };
    let tracker = budget::BudgetTracker::default();
    tracker.estimate_cost(model, prompt_tokens, completion_tokens, cache_read_tokens)
}

#[no_mangle]
pub unsafe extern "C" fn mochi_diff_numstat(
    output_ptr: *const c_char,
    out_files: *mut usize,
    out_additions: *mut usize,
    out_deletions: *mut usize,
) -> c_int {
    if output_ptr.is_null() || out_files.is_null() || out_additions.is_null() || out_deletions.is_null() {
        return -1;
    }
    let Ok(output) = (unsafe { CStr::from_ptr(output_ptr) }).to_str() else {
        return -1;
    };
    let stats = diff::parse_diff_numstat(output);
    unsafe {
        *out_files = stats.files;
        *out_additions = stats.additions;
        *out_deletions = stats.deletions;
    }
    1
}

#[no_mangle]
pub unsafe extern "C" fn mochi_classify_prompt(prompt_ptr: *const c_char) -> c_int {
    if prompt_ptr.is_null() {
        return 0;
    }
    let Ok(prompt) = (unsafe { CStr::from_ptr(prompt_ptr) }).to_str() else {
        return 0;
    };
    match planner::PlanEngine::classify_prompt(prompt) {
        planner::TaskKind::CodeEdit => 1,
        planner::TaskKind::Investigation => 2,
        planner::TaskKind::Testing => 3,
        planner::TaskKind::Refactor => 4,
        planner::TaskKind::Architecture => 5,
        planner::TaskKind::OneShotAnswer => 6,
    }
}

