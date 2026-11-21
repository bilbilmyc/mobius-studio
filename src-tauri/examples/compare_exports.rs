use std::env;
fn main() {
    let files: Vec<_> = env::args_os().skip(1).collect();
    assert_eq!(files.len(), 2);
    let a = image::open(&files[0]).unwrap().into_rgba8();
    let b = image::open(&files[1]).unwrap().into_rgba8();
    assert_eq!(a.dimensions(), (3840, 2160));
    assert_eq!(a.dimensions(), b.dimensions());
    let (mut squared, mut absolute) = (0_u64, 0_u64);
    for (p, q) in a.pixels().zip(b.pixels()) {
        assert_eq!(p[3], q[3]);
        for c in 0..3 {
            let d = u64::from(p[c].abs_diff(q[c]));
            absolute += d;
            squared += d * d;
        }
    }
    let n = f64::from(a.width()) * f64::from(a.height()) * 3.0;
    let mae = absolute as f64 / n;
    let psnr = 10.0 * (255.0_f64.powi(2) / (squared as f64 / n).max(1e-12)).log10();
    println!(
        "{}",
        serde_json::json!({"meanAbsoluteError":mae, "psnrDb":psnr})
    );
    assert!(
        mae < 2.0 && psnr >= 35.0,
        "4K export differs substantially from the CPU reference"
    );
}
