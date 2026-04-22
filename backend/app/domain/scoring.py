from __future__ import annotations

import math
from datetime import datetime

from app.domain.geometry import (
    clamp,
    decode_polyline,
    distance_meters,
    exposure_level_from_score,
    round_value,
    sample_route_points,
)
from app.domain.tree_grid import lookup_tree_cells_in_radius
from app.schemas.models import (
    ExposureLevel,
    GoogleRoute,
    LatLngLiteral,
    PollenSignal,
    RouteCandidate,
    RouteHotspot,
    RouteScoreBreakdown,
    RouteSignals,
    TreeGridCell,
    UserProfile,
    WeatherSignal,
)

TREE_EXPOSURE_RADIUS_METERS = 20
MISSING_DATA_BASELINE_BURDEN = 10
ROUTE_SAMPLE_SPACING_METERS = 60
MIN_ROUTE_SAMPLES = 10
MAX_ROUTE_SAMPLES = 40
HIGH_RISK_BURDEN_THRESHOLD = 60
TREE_EXPOSURE_WEIGHT = 0.22
P90_TREE_EXPOSURE_WEIGHT = 0.1
PEAK_TREE_EXPOSURE_WEIGHT = 0.06
HIGH_RISK_DISTANCE_DIVISOR_METERS = 400
MAX_MISSING_DATA_PENALTY = 8

SENSITIVITY_MULTIPLIERS = {
    "low": 0.88,
    "medium": 1.0,
    "high": 1.22,
}

SPECIES_SEASON_FACTOR = {
    "oak": [0.0, 0.0, 0.3, 1.0, 0.7, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "birch": [0.0, 0.1, 0.8, 1.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "maple": [0.0, 0.1, 1.0, 0.6, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "london plane": [0.0, 0.0, 0.2, 0.8, 1.0, 0.4, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0],
    "honey locust": [0.0, 0.0, 0.0, 0.2, 0.9, 1.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0],
    "elm": [0.0, 0.1, 1.0, 0.7, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "tree": [0.1, 0.2, 0.5, 0.8, 0.9, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
}

TRIGGER_ALIASES = {
    "tree": ["tree", "trees"],
    "oak": ["oak", "oaks"],
    "birch": ["birch"],
    "maple": ["maple"],
    "london plane": ["london plane", "plane"],
    "honey locust": ["honey locust", "locust"],
    "elm": ["elm"],
}


def score_routes(
    routes: list[GoogleRoute],
    profile: UserProfile,
    weather: WeatherSignal,
    pollen: PollenSignal,
    current_month: int | None = None,
    route_signals: list[RouteSignals] | None = None,
):
    if not routes:
        return []

    month = normalize_month_index(current_month)
    fastest_duration_min = min(route.durationMin for route in routes)
    scored = [
        score_single_route(
            route,
            index,
            profile,
            route_signals[index].weather if route_signals and index < len(route_signals) else weather,
            route_signals[index].pollen if route_signals and index < len(route_signals) else pollen,
            month,
            fastest_duration_min,
        )
        for index, route in enumerate(routes)
    ]
    return sorted(scored, key=lambda entry: entry["candidate"].exposureScore)


def score_single_route(
    route: GoogleRoute,
    index: int,
    profile: UserProfile,
    weather: WeatherSignal,
    pollen: PollenSignal,
    month: int,
    fastest_duration_min: float,
):
    points = decode_polyline(route.polyline)
    sample_count = get_route_sample_count(route.distanceMeters)
    sampled_points = sample_route_points(points, sample_count)

    sensitivity = SENSITIVITY_MULTIPLIERS[profile.sensitivity]
    tree_matches = profile.triggers if profile.knowsTreeTriggers else []
    general_avoidance_mode = (not profile.knowsTreeTriggers) or (not tree_matches)
    route_detour_minutes = max(route.durationMin - fastest_duration_min, 0)
    route_time_penalty = get_relative_time_penalty(route.durationMin, fastest_duration_min)
    pollen_factor = get_tree_pollen_factor(pollen)
    weather_boost = get_weather_boost(weather)

    aggregate_burden = 0.0
    peak_burden = 0.0
    burdens: list[float] = []
    covered_points = 0
    dominant_area = "NYC corridor"
    dominant_risk = 0.0
    hotspots: list[RouteHotspot] = []

    for point_index, point in enumerate(sampled_points):
        cells = lookup_tree_cells_in_radius(point, TREE_EXPOSURE_RADIUS_METERS)

        burden: float
        area_name = "NYC corridor"

        if not cells:
            burden = MISSING_DATA_BASELINE_BURDEN
        else:
            covered_points += 1
            merged = merge_cells(cells, point, TREE_EXPOSURE_RADIUS_METERS)
            area_name = merged["area_name"]
            seasonal_weights = apply_seasonality(merged["species_weights"], month)
            species_boost = get_species_match_boost(
                tree_matches,
                seasonal_weights,
                merged["top_species"],
                general_avoidance_mode,
            )
            burden = merged["canopy_score"] * species_boost

        aggregate_burden += burden
        peak_burden = max(peak_burden, burden)
        burdens.append(burden)

        if burden >= dominant_risk:
            dominant_risk = burden
            dominant_area = area_name

        hotspots.append(
            RouteHotspot(
                lat=point.lat,
                lng=point.lng,
                label=f"{area_name} hotspot {point_index + 1}",
                risk=round_value(burden, 0),
            )
        )

    normalized_burden = aggregate_burden / len(sampled_points) if sampled_points else MISSING_DATA_BASELINE_BURDEN
    p90_burden = percentile_value(burdens, 0.9) if burdens else MISSING_DATA_BASELINE_BURDEN
    data_coverage = covered_points / len(sampled_points) if sampled_points else 0.0
    high_risk_meters = (
        route.distanceMeters * (sum(1 for burden in burdens if burden >= HIGH_RISK_BURDEN_THRESHOLD) / len(burdens))
        if burdens
        else 0.0
    )
    missing_data_penalty = (1 - data_coverage) * MAX_MISSING_DATA_PENALTY

    tree_exposure = normalized_burden * TREE_EXPOSURE_WEIGHT
    p90_tree_exposure = p90_burden * P90_TREE_EXPOSURE_WEIGHT
    peak_tree_exposure = peak_burden * PEAK_TREE_EXPOSURE_WEIGHT
    high_risk_corridor_penalty = clamp(high_risk_meters / HIGH_RISK_DISTANCE_DIVISOR_METERS, 0, 6)
    tree_part = tree_exposure + p90_tree_exposure + peak_tree_exposure + high_risk_corridor_penalty
    score = clamp(
        tree_part * pollen_factor * sensitivity * weather_boost + route_time_penalty + missing_data_penalty,
        8,
        98,
    )

    exposure_level = exposure_level_from_score(score)
    rounded_score = round_value(score, 0)
    candidate = RouteCandidate(
        id=route.id,
        label=f"Route {chr(65 + index)}",
        polyline=route.polyline,
        durationMin=route.durationMin,
        distanceMeters=route.distanceMeters,
        exposureScore=rounded_score,
        exposureLevel=exposure_level,
        explanation="",
        rationale=build_rationale(exposure_level, profile, dominant_area, weather, pollen, data_coverage),
        hotspots=sorted(hotspots, key=lambda item: item.risk, reverse=True)[:3],
        scoreBreakdown=RouteScoreBreakdown(
            treeExposure=round_value(tree_exposure, 1),
            p90TreeExposure=round_value(p90_tree_exposure, 1),
            peakTreeExposure=round_value(peak_tree_exposure, 1),
            routeTimePenalty=round_value(route_time_penalty, 1),
            routeDetourMinutes=round_value(route_detour_minutes, 1),
            highRiskMeters=round_value(high_risk_meters, 0),
            dataCoverage=round_value(data_coverage, 2),
            missingDataPenalty=round_value(missing_data_penalty, 1),
            pollenFactor=round_value(pollen_factor, 2),
            weatherFactor=round_value(weather_boost, 2),
            sensitivityFactor=round_value(sensitivity, 2),
            treePollenIndex=round_value(pollen.treeIndex, 1),
            windSpeedMph=round_value(weather.windSpeedMph, 1),
            finalScore=rounded_score,
        ),
    )

    return {
        "candidate": candidate,
        "dominant_area": dominant_area,
        "dominant_level": exposure_level,
    }


def normalize_month_index(current_month: int | None):
    if current_month is None:
        return datetime.now().month - 1

    return current_month % 12


def get_route_sample_count(distance_meters: float):
    return int(
        clamp(
            math.floor(distance_meters / ROUTE_SAMPLE_SPACING_METERS + 0.5) + 1,
            MIN_ROUTE_SAMPLES,
            MAX_ROUTE_SAMPLES,
        )
    )


def percentile_value(values: list[float], percentile: float):
    if not values:
        return 0.0

    ordered_values = sorted(values)
    if len(ordered_values) == 1:
        return ordered_values[0]

    position = clamp(percentile, 0, 1) * (len(ordered_values) - 1)
    lower_index = math.floor(position)
    upper_index = math.ceil(position)

    if lower_index == upper_index:
        return ordered_values[lower_index]

    interpolation_weight = position - lower_index
    return ordered_values[lower_index] + (
        ordered_values[upper_index] - ordered_values[lower_index]
    ) * interpolation_weight


def merge_cells(
    cells: list[TreeGridCell],
    point: LatLngLiteral,
    radius_meters: float,
):
    weighted_cells = [
        {
            "cell": cell,
            "weight": get_distance_weight(distance_meters(point, cell.center), radius_meters),
        }
        for cell in cells
    ]
    total_weight = sum(entry["weight"] for entry in weighted_cells) or len(weighted_cells)

    canopy_score = sum(
        entry["cell"].canopyScore * entry["weight"]
        for entry in weighted_cells
    ) / total_weight

    all_species = {
        species
        for entry in weighted_cells
        for species in entry["cell"].speciesWeights.keys()
    }
    species_weights: dict[str, float] = {}
    for species in all_species:
        average_weight = sum(
            entry["cell"].speciesWeights.get(species, 0.0) * entry["weight"]
            for entry in weighted_cells
        ) / total_weight
        if average_weight > 0:
            species_weights[species] = float(f"{average_weight:.2f}")

    top_species = [
        species
        for species, _weight in sorted(
            species_weights.items(),
            key=lambda item: item[1],
            reverse=True,
        )[:4]
    ]

    dominant_cell = max(
        weighted_cells,
        key=lambda entry: entry["cell"].canopyScore * entry["weight"],
    )["cell"]
    return {
        "canopy_score": canopy_score,
        "species_weights": species_weights,
        "top_species": top_species,
        "area_name": dominant_cell.areaName,
    }


def get_distance_weight(distance_to_cell: float, radius_meters: float):
    effective_radius = max(radius_meters * 0.5, 1)
    normalized_distance = distance_to_cell / effective_radius
    return 1 / (1 + normalized_distance**2)


def apply_seasonality(species_weights: dict[str, float], month: int):
    seasonal_weights: dict[str, float] = {}

    for species, weight in species_weights.items():
        factors = SPECIES_SEASON_FACTOR.get(species, SPECIES_SEASON_FACTOR["tree"])
        seasonal_weights[species] = weight * factors[month]

    return seasonal_weights


def get_tree_pollen_factor(pollen: PollenSignal):
    index = pollen.treeIndex + pollen.grassIndex * 0.12 + pollen.weedIndex * 0.08
    return clamp(1 + index * 0.083, 1.0, 1.5)


def get_relative_time_penalty(duration_min: float, fastest_duration_min: float):
    if fastest_duration_min <= 0:
        return 0.0

    relative_detour = max(duration_min - fastest_duration_min, 0) / max(fastest_duration_min, 1)
    return clamp(relative_detour * 12, 0, 8)


def get_weather_boost(weather: WeatherSignal):
    wind_factor = 1 + weather.windSpeedMph / 55
    humidity_factor = 1 - clamp((weather.humidity - 40) / 220, 0, 0.22)
    temperature_factor = 1.05 if weather.temperatureF >= 75 else 0.95 if weather.temperatureF <= 45 else 1
    return clamp(wind_factor * humidity_factor * temperature_factor, 0.86, 1.34)


def get_species_match_boost(
    triggers: list[str],
    species_weights: dict[str, float],
    top_species: list[str],
    general_avoidance_mode: bool,
):
    if general_avoidance_mode:
        total_weight = sum(species_weights.values())
        return clamp(0.95 + total_weight * 0.55, 0.95, 1.55)

    matched_weight = 0.0
    for species, weight in species_weights.items():
        is_direct_trigger = species in triggers
        is_alias_match = any(
            any(alias in species for alias in TRIGGER_ALIASES.get(trigger, []))
            for trigger in triggers
        )
        matched_weight += weight if (is_direct_trigger or is_alias_match) else weight * 0.45

    top_species_boost = 0.3 if any(
        any(trigger.lower() in species.lower() for trigger in triggers)
        for species in top_species
    ) else 0.0

    return clamp(0.9 + matched_weight + top_species_boost, 0.8, 2.1)


def build_rationale(
    level: ExposureLevel,
    profile: UserProfile,
    area_name: str,
    weather: WeatherSignal,
    pollen: PollenSignal,
    data_coverage: float,
):
    lines = [f"{area_name} has elevated street-tree density relative to nearby blocks."]

    if profile.knowsTreeTriggers and profile.triggers:
        lines.append(f"This route is ranked against your selected tree triggers: {', '.join(profile.triggers[:3])}.")
    else:
        lines.append("No tree species were selected, so this route minimizes overall contact with trees.")

    if data_coverage < 0.7:
        lines.append("Tree-grid coverage is thinner on parts of this walk, so the score is less certain than usual.")
    elif pollen.treeIndex >= 4 or weather.windSpeedMph >= 12:
        lines.append(
            f"Tree pollen is elevated and wind is around {round_value(weather.windSpeedMph, 0)} mph, so spread risk is higher on exposed blocks."
        )
    elif level == "low":
        lines.append("This route trades a bit of time for meaningfully lower tree-contact exposure.")
    else:
        lines.append("This option keeps you closer to denser canopy pockets for more of the walk.")

    return lines
