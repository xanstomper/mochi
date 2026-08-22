//! Mochi Core Native Rust Engine
//! High-performance native hot-paths for fuzzy matching, search, git detection, outline extraction, and streaming.

pub mod diff;
pub mod fuzzy;
pub mod git;
pub mod search;
pub mod stream;
pub mod tokens;

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::slice;

pub use diff::*;
pub use fuzzy::*;
pub use git::*;
pub use search::*;
pub use stream::*;
pub use tokens::*;

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
