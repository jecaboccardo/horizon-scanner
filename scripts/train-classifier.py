"""
train-classifier.py

Train a small ML classifier on evals/classifier-training-set-*.csv to predict
relevant / partial / irrelevant per the human labels. Goal: a cheap fallback
for LLM-judge failures (or a pre-filter to skip the LLM on easy cases).

Models compared:
  - Logistic regression (l2)
  - Random forest (100 trees)
  - Gradient boosting (100 estimators, max_depth=3)

Reports per-model accuracy + per-class precision/recall (macro avg) under
stratified 5-fold cross-validation. Picks the best by macro-F1 and saves a
fitted-on-everything pickle.

Usage:
  python scripts/train-classifier.py
  # Optional:
  python scripts/train-classifier.py --csv evals/classifier-training-set-2026-05-13.csv

Output:
  reports/classifier-train-results-YYYY-MM-DD.md  — per-model metrics
  evals/classifier-trained-YYYY-MM-DD.pkl         — best fitted model
  evals/classifier-feature-importance-*.csv       — feature importance for tree models
"""
import argparse
import json
import os
import pickle
import sys
from datetime import date
from glob import glob

try:
    import pandas as pd
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import StratifiedKFold, cross_val_predict
    from sklearn.metrics import classification_report, confusion_matrix, f1_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Install: pip install pandas scikit-learn numpy")
    sys.exit(1)


def find_latest_csv():
    files = sorted(glob("evals/classifier-training-set-*.csv"))
    if not files:
        raise FileNotFoundError("No evals/classifier-training-set-*.csv found. Run scripts/build-classifier-training-set.mjs first.")
    return files[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default=None, help="Path to training CSV (default: latest)")
    args = parser.parse_args()
    csv_path = args.csv or find_latest_csv()
    print(f"Loading {csv_path}")
    df = pd.read_csv(csv_path)
    print(f"Rows: {len(df)}")
    print(f"Label distribution: {df['label'].value_counts().to_dict()}")

    feature_cols = [
        "facet_sim_0", "facet_sim_1", "facet_sim_2",
        "facet_sim_0_above_floor", "facet_sim_1_above_floor", "facet_sim_2_above_floor",
        "facet_sims_geometric_mean",
        "single_vector_sim",
        "geography_hit",
        "year", "age_years", "citation_count", "citation_rate",
        "sms_level", "has_abstract", "abstract_length",
        "abs_rating_numeric", "repec_percentile",
    ]
    X = df[feature_cols].fillna(0).to_numpy()
    y = df["label_int"].to_numpy()
    label_map = {0: "irrelevant", 1: "partial", 2: "relevant"}

    models = {
        "logistic_l2": Pipeline([
            ("scale", StandardScaler()),
            ("lr", LogisticRegression(max_iter=1000, class_weight="balanced", C=1.0))
        ]),
        "random_forest": RandomForestClassifier(
            n_estimators=200, max_depth=8, min_samples_leaf=3,
            class_weight="balanced", random_state=42, n_jobs=-1,
        ),
        "gradient_boosting": GradientBoostingClassifier(
            n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42,
        ),
    }

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    today = date.today().isoformat()
    md_lines = [f"# Classifier training — {today}", "", f"Training set: `{csv_path}` ({len(df)} rows × {len(feature_cols)} features)", "", f"Label distribution: {df['label'].value_counts().to_dict()}", "", "## Per-model 5-fold CV results", ""]
    md_lines.append("| Model | Accuracy | Macro-F1 | Per-class (irrelevant / partial / relevant) F1 |")
    md_lines.append("|---|---:|---:|---|")

    summaries = {}
    for name, model in models.items():
        print(f"\n=== {name} ===")
        y_pred = cross_val_predict(model, X, y, cv=cv, n_jobs=-1)
        acc = (y_pred == y).mean()
        macro_f1 = f1_score(y, y_pred, average="macro", zero_division=0)
        per_class_f1 = f1_score(y, y_pred, average=None, labels=[0, 1, 2], zero_division=0)
        print(f"Accuracy: {acc:.3f}  Macro-F1: {macro_f1:.3f}")
        print(classification_report(y, y_pred, target_names=[label_map[i] for i in [0, 1, 2]], digits=3, zero_division=0))
        print("Confusion matrix (rows=true, cols=pred, order=irrel/part/rel):")
        cm = confusion_matrix(y, y_pred, labels=[0, 1, 2])
        for i, row in enumerate(cm):
            print(f"  {label_map[i]:<11} {row.tolist()}")

        md_lines.append(
            f"| {name} | {acc:.3f} | {macro_f1:.3f} | "
            f"{per_class_f1[0]:.2f} / {per_class_f1[1]:.2f} / {per_class_f1[2]:.2f} |"
        )

        summaries[name] = {
            "accuracy": float(acc),
            "macro_f1": float(macro_f1),
            "per_class_f1": [float(x) for x in per_class_f1],
            "confusion_matrix": cm.tolist(),
        }

    # Pick best by macro-F1, fit on full data, save
    best_name = max(summaries, key=lambda n: summaries[n]["macro_f1"])
    print(f"\nBest model by macro-F1: {best_name} ({summaries[best_name]['macro_f1']:.3f})")
    best_model = models[best_name]
    best_model.fit(X, y)

    pkl_path = f"evals/classifier-trained-{today}.pkl"
    with open(pkl_path, "wb") as f:
        pickle.dump({"model": best_model, "features": feature_cols, "label_map": label_map, "name": best_name}, f)
    print(f"Saved fitted model: {pkl_path}")

    # Export the LOGISTIC model to a JSON the Deno runtime can load without
    # sklearn. Logistic regression is tiny (54 weights + 3 biases for our
    # 18 features × 3 classes); pure-JS scoring is trivial. Quality is lower
    # than the RF but it's the simplest deployable shape.
    lr_pipeline = models["logistic_l2"]
    lr_pipeline.fit(X, y)
    scaler = lr_pipeline.named_steps["scale"]
    clf = lr_pipeline.named_steps["lr"]
    deployable = {
        "kind": "logistic_l2",
        "features": feature_cols,
        "classes": clf.classes_.tolist(),
        "label_map": label_map,
        # Standardise inputs: (x - mean) / scale
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        # Logistic: score[c] = X @ coef[c] + intercept[c], then softmax → argmax
        "coef": clf.coef_.tolist(),
        "intercept": clf.intercept_.tolist(),
        "trained_at": today,
        "n_train_rows": int(len(X)),
    }
    deploy_path = f"evals/classifier-deployable-{today}.json"
    with open(deploy_path, "w", encoding="utf8") as f:
        json.dump(deployable, f, indent=2)
    print(f"Saved Deno-deployable model: {deploy_path}")

    # Also export the Random Forest as a deployable JSON. The TS runtime in
    # trainedClassifier.ts traverses each tree and averages class probabilities.
    # No scaler needed (RF is invariant to monotonic transforms).
    rf = models["random_forest"]
    rf.fit(X, y)
    rf_trees = []
    for est in rf.estimators_:
        t = est.tree_
        nodes = []
        for i in range(t.node_count):
            if t.children_left[i] == -1:  # leaf
                # value shape: (1, n_classes); rescale to probabilities
                v = t.value[i][0]
                total = float(v.sum())
                probs = [float(c) / total if total > 0 else 0.0 for c in v]
                nodes.append({"leaf": True, "value": probs})
            else:
                nodes.append({
                    "feature": int(t.feature[i]),
                    "threshold": float(t.threshold[i]),
                    "left": int(t.children_left[i]),
                    "right": int(t.children_right[i]),
                })
        rf_trees.append(nodes)

    rf_deployable = {
        "kind": "random_forest",
        "features": feature_cols,
        "classes": rf.classes_.tolist(),
        "label_map": label_map,
        "trees": rf_trees,
        "n_estimators": int(rf.n_estimators),
        "trained_at": today,
        "n_train_rows": int(len(X)),
        "macro_f1_cv": float(summaries["random_forest"]["macro_f1"]),
    }
    rf_path = f"evals/classifier-deployable-rf-{today}.json"
    with open(rf_path, "w", encoding="utf8") as f:
        json.dump(rf_deployable, f, separators=(",", ":"))  # compact for size
    rf_size_mb = os.path.getsize(rf_path) / 1024 / 1024
    print(f"Saved Deno-deployable RF model: {rf_path} ({rf_size_mb:.2f} MB, {len(rf_trees)} trees)")

    # Feature importance for tree models
    if best_name in ("random_forest", "gradient_boosting"):
        importances = best_model.feature_importances_
        order = np.argsort(importances)[::-1]
        fi_path = f"evals/classifier-feature-importance-{today}.csv"
        with open(fi_path, "w", encoding="utf8") as f:
            f.write("feature,importance\n")
            for i in order:
                f.write(f"{feature_cols[i]},{importances[i]:.4f}\n")
        print(f"Saved feature importance: {fi_path}")
        md_lines.append("")
        md_lines.append(f"## Feature importance — {best_name}")
        md_lines.append("")
        md_lines.append("| Feature | Importance |")
        md_lines.append("|---|---:|")
        for i in order[:10]:
            md_lines.append(f"| {feature_cols[i]} | {importances[i]:.3f} |")

    md_lines.append("")
    md_lines.append("## Interpretation")
    md_lines.append("")
    md_lines.append("- Macro-F1 is the right headline metric here — accuracy is misleading because the `irrelevant` class is only ~6% of the data.")
    md_lines.append("- Per-class F1 reveals if the model is learning the rare `irrelevant` class or just shortcutting to majority.")
    md_lines.append("- The trained model can be used as a fallback when LLM-judge fails, or as a pre-filter (skip LLM for clear partial/relevant predictions).")
    md_lines.append("")
    md_lines.append(f"All-model summary (JSON): see `evals/classifier-trained-{today}.json`")

    out_md = f"reports/classifier-train-results-{today}.md"
    with open(out_md, "w", encoding="utf8") as f:
        f.write("\n".join(md_lines) + "\n")
    print(f"Saved report: {out_md}")

    with open(f"evals/classifier-trained-{today}.json", "w", encoding="utf8") as f:
        json.dump({"date": today, "csv": csv_path, "best": best_name, "summaries": summaries, "features": feature_cols}, f, indent=2)


if __name__ == "__main__":
    main()
