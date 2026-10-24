#!/usr/bin/env python3
"""Build a local OSM mosque-map sidecar and conservative Ministry matches.

This is a read-only, offline data-preparation tool. It never opens the app database
and does not geocode or infer locations. It needs PyOsmium and Shapely 2+:
  python3 -m pip install osmium shapely

Example:
  python3 scripts/match-osm-mosques.py \
    --pbf /path/to/jordan-latest.osm.pbf \
    --output data/osm_mosque_map_points.json \
    --audit-report data/osm_mosque_match_audit.json
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / "data" / "official_mosques.json"
GEOFABRIK_PAGE = "https://download.geofabrik.de/asia/jordan.html"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"
JORDAN_BOUNDS = {"min_lat": 29.0, "max_lat": 33.5, "min_lon": 34.5, "max_lon": 39.5}
MUSLIM_RELIGIONS = {"muslim", "islam"}
NON_MOSQUE_BUILDINGS = {"church", "cathedral", "chapel", "synagogue", "temple"}
NON_RELIGIOUS_BUILDINGS = {
    "apartments", "commercial", "house", "industrial", "office", "residential",
    "retail", "school", "stadium", "university", "warehouse",
}
NAME_TAGS = (
    "name:ar", "official_name:ar", "alt_name:ar", "short_name:ar", "old_name:ar",
    "name", "official_name", "alt_name", "short_name", "old_name",
)
CONTEXT_TAGS = (
    "addr:city", "addr:suburb", "addr:place", "addr:district", "addr:neighbourhood",
    "addr:province", "addr:state", "is_in", "is_in:city", "is_in:municipality", "is_in:district",
)
ADMIN_PREFIXES = {"مديرية", "لواء", "قضاء", "محافظة", "منطقة"}
MOSQUE_PREFIXES = {"مسجد", "الجامع", "جامع", "المسجد"}
ARABIC_LETTER_MAP = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي"})
MOSQUE_NAME_START = re.compile(r"^(?:المسجد|مسجد|الجامع|جامع|mosque|masjid|mosquée|mezquita)(?:\s|$)", re.IGNORECASE)
SPLIT_CONTEXT = re.compile(r"[,;/|]")
PLACE_CONTEXT_TYPES = {
    "city", "town", "village", "suburb", "neighbourhood", "hamlet", "quarter",
    "municipality", "borough", "district", "locality",
}


def normalize_text(value: Any, *, strip_mosque_prefix: bool = False) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).translate(ARABIC_LETTER_MAP)
    text = "".join(
        character
        for character in text
        if character != "ـ" and unicodedata.category(character) not in {"Mn", "Me"}
    ).casefold()
    text = re.sub(r"[^\w\s]+", " ", text, flags=re.UNICODE)
    words = text.split()
    if strip_mosque_prefix:
        while words and words[0] in MOSQUE_PREFIXES:
            words.pop(0)
    return " ".join(words)


def normalize_context(value: Any) -> str:
    words = normalize_text(value).split()
    while words and words[0] in ADMIN_PREFIXES:
        words.pop(0)
    return " ".join(words)


def split_values(value: Any) -> list[str]:
    return [part.strip() for part in SPLIT_CONTEXT.split(str(value or "")) if part.strip()]


def name_variants(tags: dict[str, str]) -> list[str]:
    values: list[str] = []
    for key in NAME_TAGS:
        value = tags.get(key, "").strip()
        if not value:
            continue
        candidates = split_values(value) if key.startswith(("alt_name", "old_name", "short_name")) else [value]
        for candidate in candidates:
            if candidate and candidate not in values:
                values.append(candidate)
    return values


def context_values(tags: dict[str, str]) -> set[str]:
    values: set[str] = set()
    for key in CONTEXT_TAGS:
        for part in split_values(tags.get(key)):
            normalized = normalize_context(part)
            if normalized and normalized not in {"jordan", "الاردن"}:
                values.add(normalized)
    return values


def religion_values(tags: dict[str, str]) -> set[str]:
    return {
        item.strip().casefold()
        for item in re.split(r"[;,|]", tags.get("religion", ""))
        if item.strip()
    }


def has_muslim_denominations(tags: dict[str, str]) -> bool:
    denomination = tags.get("denomination", "").casefold()
    return any(term in denomination for term in ("sunni", "shia", "shi'a"))


def has_musalla_name(names: list[str]) -> bool:
    return any(re.match(r"^\s*(?:مصلى|المصلى|musalla|prayer room)(?:\s|$)", name, re.IGNORECASE) for name in names)


def feature_kind(tags: dict[str, str], names: list[str]) -> str | None:
    """Return mosque/musalla only for explicit Muslim worship or a clear POI name."""
    religion = religion_values(tags)
    muslim = bool(religion.intersection(MUSLIM_RELIGIONS)) or has_muslim_denominations(tags)
    if religion and not religion.intersection(MUSLIM_RELIGIONS):
        return None

    amenity = tags.get("amenity", "").casefold()
    building = tags.get("building", "").casefold()
    worship_type = tags.get("place_of_worship", "").casefold()
    musalla_name = has_musalla_name(names)

    explicit_musalla = (
        worship_type in {"prayer", "musalla"}
        or amenity == "prayer_room"
        or building in {"prayer_room", "musalla"}
        or (musalla_name and amenity == "place_of_worship")
    )
    if explicit_musalla:
        islamic_signal = muslim or worship_type == "musalla" or musalla_name
        return "musalla" if islamic_signal else None

    if building in NON_MOSQUE_BUILDINGS:
        return None

    explicit_mosque = (
        building == "mosque"
        or worship_type in {"mosque", "masjid"}
        or amenity == "mosque"
        or (amenity == "place_of_worship" and muslim)
    )
    if explicit_mosque:
        return "mosque"

    if worship_type and worship_type not in {"mosque", "masjid"}:
        return None
    if amenity and amenity != "place_of_worship":
        return None
    if building and building not in {"yes", "religious", "place_of_worship"}:
        if building in NON_RELIGIOUS_BUILDINGS or building not in {"mosque", "place_of_worship"}:
            return None
    if any(tags.get(key) for key in ("boundary", "highway", "place", "natural", "waterway", "landuse")):
        return None
    if religion and not muslim:
        return None
    if amenity == "place_of_worship" and (muslim or musalla_name):
        return "mosque"

    # Name-only fallback is intentionally narrow: a place name must start with
    # a mosque word and must not be tagged as a street, settlement or boundary.
    if any(MOSQUE_NAME_START.match(name.strip()) for name in names):
        return "mosque"
    return None


def is_inside_jordan_box(latitude: float, longitude: float) -> bool:
    """Cheap broad prefilter only; final inclusion uses the PBF's Jordan polygon."""
    return (
        JORDAN_BOUNDS["min_lat"] <= latitude <= JORDAN_BOUNDS["max_lat"]
        and JORDAN_BOUNDS["min_lon"] <= longitude <= JORDAN_BOUNDS["max_lon"]
    )


def is_jordan_country_boundary(tags: dict[str, str]) -> bool:
    if tags.get("boundary") != "administrative" or tags.get("admin_level") != "2":
        return False
    country_codes = {tags.get("ISO3166-1", "").upper(), tags.get("ISO3166-1:alpha2", "").upper()}
    names = {normalize_context(tags.get(key)) for key in ("name", "name:en", "name:ar", "official_name")}
    return "JO" in country_codes or bool(names.intersection({"jordan", "الاردن"}))


def is_context_area(tags: dict[str, str]) -> bool:
    admin_level = tags.get("admin_level", "")
    return (
        tags.get("boundary") == "administrative" and admin_level in {"4", "5", "6", "7", "8", "9"}
    ) or tags.get("place", "").casefold() in PLACE_CONTEXT_TYPES


def area_context_names(tags: dict[str, str]) -> set[str]:
    values: set[str] = set()
    for key in ("name:ar", "official_name:ar", "alt_name:ar", "name", "official_name", "alt_name"):
        for part in split_values(tags.get(key)):
            normalized = normalize_context(part)
            if normalized and normalized not in {"jordan", "الاردن"}:
                values.add(normalized)
    return values


def official_contexts(record: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for key in ("locality", "directorate", "governorate"):
        for part in split_values(record.get(key)):
            normalized = normalize_context(part)
            if normalized and normalized not in {"jordan", "الاردن"}:
                values.add(normalized)
    return values


def pbf_timestamp(osmium: Any, pbf_path: Path) -> str | None:
    reader = osmium.io.Reader(str(pbf_path))
    try:
        header = reader.header()
        return header.get("osmosis_replication_timestamp") or header.get("timestamp")
    finally:
        reader.close()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_osm_features(osmium: Any, pbf_path: Path) -> tuple[list[dict[str, Any]], Counter[str]]:
    try:
        shapely_module: Any = importlib.import_module("shapely")
        geometry_module: Any = importlib.import_module("shapely.geometry")
        ops_module: Any = importlib.import_module("shapely.ops")
        strtree_module: Any = importlib.import_module("shapely.strtree")
        make_valid = getattr(shapely_module, "make_valid")
        Point = getattr(geometry_module, "Point")
        shape = getattr(geometry_module, "shape")
        unary_union = getattr(ops_module, "unary_union")
        STRtree = getattr(strtree_module, "STRtree")
    except (ImportError, AttributeError) as exc:
        raise SystemExit("Shapely 2+ is required; install it with: python3 -m pip install shapely") from exc

    features: list[dict[str, Any]] = []
    stats: Counter[str] = Counter()
    context_shapes: list[Any] = []
    context_names: list[set[str]] = []
    country_shapes: list[Any] = []
    factory = osmium.geom.GeoJSONFactory()

    def add_feature(osm_type: str, osm_id: int, tags: dict[str, str], kind: str, latitude: float, longitude: float, geometry_method: str) -> None:
        if not is_inside_jordan_box(latitude, longitude):
            stats["outside_jordan_prefilter"] += 1
            return
        names = name_variants(tags)
        name_keys = sorted({normalize_text(name, strip_mosque_prefix=True) for name in names} - {""})
        features.append(
            {
                "osmType": osm_type,
                "osmId": int(osm_id),
                "kind": kind,
                "latitude": round(float(latitude), 7),
                "longitude": round(float(longitude), 7),
                "geometryMethod": geometry_method,
                "names": names[:8],
                "nameKeys": name_keys,
                "contexts": sorted(context_values(tags)),
            }
        )
        stats[f"{kind}_features_{osm_type}"] += 1
        stats[f"{kind}_features_named" if names else f"{kind}_features_unnamed"] += 1

    processor = osmium.FileProcessor(str(pbf_path)).with_locations().with_areas()
    for obj in processor:
        if obj.is_node():
            tags = dict(obj.tags)
            names = name_variants(tags)
            kind = feature_kind(tags, names)
            if not kind:
                continue
            if not obj.location.valid():
                stats["invalid_node_locations"] += 1
                continue
            add_feature("node", obj.id, tags, kind, obj.location.lat, obj.location.lon, "osm-node")
            continue

        if not obj.is_area():
            continue

        tags = dict(obj.tags)
        osm_type = "way" if obj.from_way() else "relation"
        osm_id = int(obj.orig_id())
        names = name_variants(tags)
        kind = feature_kind(tags, names)
        is_country = is_jordan_country_boundary(tags)
        is_context = is_context_area(tags)
        if not (kind or is_country or is_context):
            continue

        try:
            geometry = shape(json.loads(factory.create_multipolygon(obj)))
            if not geometry.is_valid:
                geometry = make_valid(geometry)
            if geometry.is_empty:
                stats["invalid_area_geometries"] += 1
                continue
        except Exception:
            stats["invalid_area_geometries"] += 1
            continue

        if is_country:
            country_shapes.append(geometry)
            stats["jordan_country_boundary_areas"] += 1
        if is_context:
            names_for_context = area_context_names(tags)
            if names_for_context:
                context_shapes.append(geometry)
                context_names.append(names_for_context)
        if kind:
            point = geometry.representative_point()
            add_feature(osm_type, osm_id, tags, kind, point.y, point.x, f"osm-{osm_type}-area-representative-point")

    if not country_shapes:
        raise RuntimeError("Could not find Jordan's admin_level=2 boundary in the PBF; refusing approximate country filtering")
    country_geometry = unary_union(country_shapes)
    if not country_geometry.is_valid:
        country_geometry = make_valid(country_geometry)

    jordan_features: list[dict[str, Any]] = []
    for feature in features:
        point = Point(feature["longitude"], feature["latitude"])
        if not country_geometry.covers(point):
            stats["outside_jordan_country_polygon"] += 1
            continue
        jordan_features.append(feature)
    features = jordan_features

    if context_shapes:
        context_tree = STRtree(context_shapes)
        for feature in features:
            point = Point(feature["longitude"], feature["latitude"])
            for index in context_tree.query(point, predicate="intersects"):
                feature["contexts"] = sorted(set(feature["contexts"]).union(context_names[int(index)]))

    features.sort(key=lambda item: (item["kind"], item["osmType"], item["osmId"]))
    stats["featuresInsideJordanPolygon"] = len(features)
    stats["featuresWithNames"] = sum(bool(item["names"]) for item in features)
    stats["featuresWithoutNames"] = len(features) - stats["featuresWithNames"]
    return features, stats


def has_official_coordinates(record: dict[str, Any]) -> bool:
    try:
        latitude_value = record.get("latitude")
        longitude_value = record.get("longitude")
        if latitude_value is None or longitude_value is None:
            return False
        latitude = float(latitude_value)
        longitude = float(longitude_value)
    except (TypeError, ValueError):
        return False
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return False
    # Keep the coordinates supplied by the Ministry unchanged; this broad
    # validity envelope never creates or approximates a location.
    return is_inside_jordan_box(latitude, longitude)


def build_matches(
    records: list[dict[str, Any]],
    features: list[dict[str, Any]],
) -> tuple[dict[tuple[str, int], dict[str, Any]], dict[str, Any]]:
    official_by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        key = normalize_text(record.get("name"), strip_mosque_prefix=True)
        if key:
            official_by_key[key].append(record)

    osm_by_key: dict[str, dict[tuple[str, int], dict[str, Any]]] = defaultdict(dict)
    for feature in features:
        if feature["kind"] != "mosque":
            continue
        element_key = (feature["osmType"], feature["osmId"])
        for key in feature["nameKeys"]:
            osm_by_key[key][element_key] = feature

    records_with_coordinates = 0
    missing_records: list[dict[str, Any]] = []
    for record in records:
        if has_official_coordinates(record):
            records_with_coordinates += 1
        else:
            missing_records.append(record)

    proposals: list[dict[str, Any]] = []
    unmatched_by_name = 0
    ambiguous: list[dict[str, Any]] = []
    for record in records:
        key = normalize_text(record.get("name"), strip_mosque_prefix=True)
        matches = list(osm_by_key.get(key, {}).values()) if key else []
        if not matches:
            if not has_official_coordinates(record):
                unmatched_by_name += 1
            continue

        contexts = official_contexts(record)
        contextual = [feature for feature in matches if contexts.intersection(feature["contexts"])]
        if len(contextual) == 1:
            eligible = contextual
            method = "exact-normalized-name+exact-area-context"
        elif len(contextual) > 1:
            eligible = contextual
            method = "ambiguous-context"
        elif len(official_by_key.get(key, [])) == 1 and len(matches) == 1:
            eligible = matches
            method = "exact-normalized-name+unique-in-jordan"
        else:
            eligible = matches
            method = "ambiguous-name-or-location"

        if method.startswith("ambiguous"):
            ambiguous.append(
                {
                    "sourceKey": record.get("sourceKey"),
                    "officialName": record.get("name"),
                    "directorate": record.get("directorate"),
                    "locality": record.get("locality"),
                    "candidateCount": len(eligible),
                    "reason": method,
                    "candidates": [
                        {
                            "osmType": feature["osmType"],
                            "osmId": feature["osmId"],
                            "osmNames": feature["names"][:3],
                            "contexts": feature["contexts"],
                        }
                        for feature in eligible[:10]
                    ],
                }
            )
            continue

        proposals.append(
            {
                "record": record,
                "feature": eligible[0],
                "matchMethod": method,
                "hasCoordinates": has_official_coordinates(record),
            }
        )

    proposal_targets = Counter(
        (proposal["feature"]["osmType"], proposal["feature"]["osmId"])
        for proposal in proposals
    )
    matches_by_element: dict[tuple[str, int], dict[str, Any]] = {}
    reused_target_count = 0
    for proposal in proposals:
        feature = proposal["feature"]
        element_key = (feature["osmType"], feature["osmId"])
        if proposal_targets[element_key] != 1:
            reused_target_count += 1
            ambiguous.append(
                {
                    "sourceKey": proposal["record"].get("sourceKey"),
                    "officialName": proposal["record"].get("name"),
                    "directorate": proposal["record"].get("directorate"),
                    "locality": proposal["record"].get("locality"),
                    "candidateCount": proposal_targets[element_key],
                    "reason": "one-osm-feature-matched-to-multiple-official-records",
                    "candidates": [{"osmType": feature["osmType"], "osmId": feature["osmId"]}],
                }
            )
            continue
        record = proposal["record"]
        matches_by_element[element_key] = {
            "sourceKey": record["sourceKey"],
            "officialName": record["name"],
            "officialHasCoordinates": proposal["hasCoordinates"],
            "matchMethod": proposal["matchMethod"],
        }

    match_rows = list(matches_by_element.values())
    matches_for_missing = sum(not item["officialHasCoordinates"] for item in match_rows)
    matches_for_existing = sum(item["officialHasCoordinates"] for item in match_rows)
    audit = {
        "officialRecords": len(records),
        "officialRecordsWithExistingCoordinates": records_with_coordinates,
        "officialRecordsWithoutExistingCoordinates": len(missing_records),
        "namedOsmMosqueFeatures": sum(feature["kind"] == "mosque" and bool(feature["names"]) for feature in features),
        "allOsmFeatures": len(features),
        "strictMatchesAccepted": len(matches_by_element),
        "matchesAddingOfficialCoverage": matches_for_missing,
        "matchesLinkedToExistingOfficialCoordinates": matches_for_existing,
        "matchesByMethod": dict(Counter(item["matchMethod"] for item in match_rows)),
        "unmatchedOfficialRecordsByName": unmatched_by_name,
        "ambiguousOrNonOneToOneRecords": len(ambiguous),
        "duplicateCandidateClaimsExcluded": reused_target_count,
        "ambiguousExamples": ambiguous[:100],
    }
    return matches_by_element, audit


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True, type=Path, help="Local Jordan .osm.pbf extract")
    parser.add_argument("--output", required=True, type=Path, help="Output OSM map sidecar JSON path")
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE, help="Official registry JSON path")
    parser.add_argument("--audit-report", type=Path, help="Optional JSON report path for match and extraction counts")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.pbf.is_file():
        raise SystemExit(f"PBF file not found: {args.pbf}")
    if not args.archive.is_file():
        raise SystemExit(f"Official archive not found: {args.archive}")

    try:
        osmium = importlib.import_module("osmium")
    except ImportError as exc:
        raise SystemExit("PyOsmium is required; install it with: python3 -m pip install osmium") from exc

    archive = json.loads(args.archive.read_text(encoding="utf-8"))
    records = archive.get("records")
    if not isinstance(records, list) or len(records) != archive.get("recordsCount"):
        raise SystemExit("Official archive record count does not match recordsCount")
    source_keys = [record.get("sourceKey") for record in records]
    if any(not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key, re.IGNORECASE) for key in source_keys):
        raise SystemExit("Official archive has an invalid sourceKey")
    if len(set(source_keys)) != len(source_keys):
        raise SystemExit("Official archive contains duplicate sourceKeys")

    timestamp = pbf_timestamp(osmium, args.pbf)
    osm_features, osm_stats = collect_osm_features(osmium, args.pbf)
    matches_by_element, audit = build_matches(records, osm_features)
    audit["osmExtractionStats"] = dict(osm_stats)
    audit["osmBaseTimestamp"] = timestamp
    audit["pbfSha256"] = sha256_file(args.pbf)

    output_features = []
    for feature in osm_features:
        key = (feature["osmType"], feature["osmId"])
        osm_name = feature["names"][0] if feature["names"] else None
        output_features.append(
            {
                "osmType": feature["osmType"],
                "osmId": feature["osmId"],
                "osmUrl": f"https://www.openstreetmap.org/{feature['osmType']}/{feature['osmId']}",
                "kind": feature["kind"],
                "osmName": osm_name,
                "alternateNames": feature["names"][1:5],
                "latitude": feature["latitude"],
                "longitude": feature["longitude"],
                "geometryMethod": feature["geometryMethod"],
                "officialMatch": matches_by_element.get(key),
            }
        )

    sidecar = {
        "metadata": {
            "source": "OpenStreetMap contributors via Geofabrik Jordan extract",
            "sourcePage": GEOFABRIK_PAGE,
            "osmBaseTimestamp": timestamp,
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "pbfSha256": audit["pbfSha256"],
            "countryBoundary": "OSM relation 184818 (admin_level=2, ISO3166-1=JO)",
            "license": "Open Database License 1.0 (ODbL)",
            "licenseUrl": OSM_COPYRIGHT,
            "attribution": "© OpenStreetMap contributors",
            "featureSelectionPolicy": (
                "Include explicit Muslim mosque/place-of-worship tags and explicit prayer-room/musalla tags with an Islamic signal; "
                "a narrow name-only mosque fallback is allowed only when no conflicting street, settlement, boundary, landuse, or non-religious building tags exist."
            ),
            "coordinatePolicy": (
                "Use exact OSM node locations or representative points on valid mapped areas; require coverage by the Jordan admin_level=2 boundary. "
                "No geocoding or administrative-centre estimates."
            ),
            "matchPolicy": (
                "An OSM mosque feature is linked to a Ministry record only by exact normalized name plus exact area context, "
                "or by a name unique in both the Ministry registry and Jordan OSM extract. Ambiguous and reused matches are excluded."
            ),
            "featuresCount": len(output_features),
            "featuresByKind": dict(Counter(feature["kind"] for feature in output_features)),
            "officialMatchesCount": len(matches_by_element),
            "officialMatchesAddingCoverage": audit["matchesAddingOfficialCoverage"],
        },
        "features": output_features,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.audit_report:
        args.audit_report.parent.mkdir(parents=True, exist_ok=True)
        args.audit_report.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({**audit, "output": str(args.output), "featuresByKind": sidecar["metadata"]["featuresByKind"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
