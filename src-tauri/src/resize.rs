// ─────────────────────────────────────────────────────────────────────────────
// resize.rs — aspect-ratio enforcement for WM_SIZING (pure maths, no WinAPI)
// ─────────────────────────────────────────────────────────────────────────────

/// WMSZ_* edge codes sent in `wparam` of WM_SIZING (corners only are handled).
const WMSZ_TOPLEFT: u32 = 4;
const WMSZ_TOPRIGHT: u32 = 5;
const WMSZ_BOTTOMLEFT: u32 = 7;
const WMSZ_BOTTOMRIGHT: u32 = 8;

/// Adjust a window rect `(left, top, right, bottom)` that is being dragged by
/// `edge` so that `height / width == ratio`. The corner opposite the dragged one
/// stays fixed. Non-corner edges (and degenerate rects) are returned unchanged.
pub fn fit_aspect(edge: u32, rect: (i32, i32, i32, i32), ratio: f32) -> (i32, i32, i32, i32) {
    let (mut left, mut top, mut right, mut bottom) = rect;
    let (drag_left, drag_top) = match edge {
        WMSZ_TOPLEFT => (true, true),
        WMSZ_TOPRIGHT => (false, true),
        WMSZ_BOTTOMLEFT => (true, false),
        WMSZ_BOTTOMRIGHT => (false, false),
        _ => return rect,
    };

    let width = right - left;
    let height = bottom - top;
    if width <= 0 || height <= 0 || ratio <= 0.0 {
        return rect;
    }

    if (height as f32 / width as f32) > ratio {
        // Too tall: derive the width from the height by moving the dragged vertical edge.
        let new_w = (height as f32 / ratio).round() as i32;
        if drag_left { left = right - new_w } else { right = left + new_w }
    } else {
        // Too wide: derive the height from the width by moving the dragged horizontal edge.
        let new_h = (width as f32 * ratio).round() as i32;
        if drag_top { top = bottom - new_h } else { bottom = top + new_h }
    }
    (left, top, right, bottom)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The original four-branch implementation, kept as a reference.
    fn reference(edge: u32, r: (i32, i32, i32, i32), ratio: f32) -> (i32, i32, i32, i32) {
        let (mut l, mut t, mut rt, mut b) = r;
        let width = rt - l;
        let height = b - t;
        let tall = (height as f32 / width as f32) > ratio;
        match edge {
            8 => if tall { rt = l + (height as f32 / ratio).round() as i32 } else { b = t + (width as f32 * ratio).round() as i32 },
            7 => if tall { l = rt - (height as f32 / ratio).round() as i32 } else { b = t + (width as f32 * ratio).round() as i32 },
            5 => if tall { rt = l + (height as f32 / ratio).round() as i32 } else { t = b - (width as f32 * ratio).round() as i32 },
            4 => if tall { l = rt - (height as f32 / ratio).round() as i32 } else { t = b - (width as f32 * ratio).round() as i32 },
            _ => {}
        }
        (l, t, rt, b)
    }

    #[test]
    fn matches_original_for_all_corners() {
        for &ratio in &[490.0 / 300.0, 0.5, 1.0, 2.7] {
            for edge in [4u32, 5, 7, 8] {
                for w in (50..900).step_by(37) {
                    for h in (50..900).step_by(41) {
                        let rect = (100, 200, 100 + w, 200 + h);
                        assert_eq!(fit_aspect(edge, rect, ratio), reference(edge, rect, ratio),
                                   "edge={edge} w={w} h={h} ratio={ratio}");
                    }
                }
            }
        }
    }

    #[test]
    fn side_edges_and_degenerate_rects_are_untouched() {
        assert_eq!(fit_aspect(1, (0, 0, 100, 100), 1.5), (0, 0, 100, 100));
        assert_eq!(fit_aspect(8, (0, 0, 0, 100), 1.5), (0, 0, 0, 100));
    }
}
