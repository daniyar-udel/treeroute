import unittest

from app.domain.geometry import encode_polyline, sample_route_points
from app.domain.scoring import get_relative_time_penalty, merge_cells, percentile_value, score_routes
from app.schemas.models import GoogleRoute, LatLngLiteral, PollenSignal, RouteSignals, TreeGridCell, UserProfile, WeatherSignal

WEATHER = WeatherSignal(
    description="Breezy and dry",
    windSpeedMph=12,
    humidity=46,
    temperatureF=66,
)

POLLEN = PollenSignal(
    treeIndex=4,
    grassIndex=1,
    weedIndex=1,
    summary="Tree pollen elevated",
)


def build_route(route_id: str, points: list[tuple[float, float]], duration_min: float, distance_meters: float):
    return GoogleRoute(
        id=route_id,
        polyline=encode_polyline([LatLngLiteral(lat=lat, lng=lng) for lat, lng in points]),
        durationMin=duration_min,
        distanceMeters=distance_meters,
    )


class ScoreRoutesTests(unittest.TestCase):
    month = 3

    def test_increases_exposure_when_trigger_overlap_is_stronger(self):
        route = build_route(
            "r1",
            [(40.772, -73.985), (40.788, -73.983)],
            18,
            1800,
        )

        mild_profile = UserProfile(
            triggers=[],
            sensitivity="medium",
            knowsTreeTriggers=False,
        )
        tree_profile = UserProfile(
            triggers=["oak"],
            sensitivity="medium",
            knowsTreeTriggers=True,
        )

        mild_score = score_routes([route], mild_profile, WEATHER, POLLEN, current_month=self.month)[0]["candidate"].exposureScore
        tree_score = score_routes([route], tree_profile, WEATHER, POLLEN, current_month=self.month)[0]["candidate"].exposureScore

        self.assertGreater(tree_score, mild_score)

    def test_can_rank_a_longer_lower_burden_route_above_a_shorter_higher_burden_route(self):
        risky_route = build_route(
            "risky",
            [(40.776, -73.985), (40.789, -73.984)],
            15,
            1500,
        )
        safer_route = build_route(
            "safer",
            [(40.752, -73.998), (40.764, -73.97)],
            22,
            2500,
        )
        profile = UserProfile(
            triggers=["oak"],
            sensitivity="medium",
            knowsTreeTriggers=True,
        )

        best = score_routes([risky_route, safer_route], profile, WEATHER, POLLEN, current_month=self.month)[0]
        self.assertEqual(best["candidate"].id, "safer")

    def test_raises_scores_for_highly_sensitive_users(self):
        route = build_route(
            "r1",
            [(40.74, -73.984), (40.752, -73.97)],
            16,
            1600,
        )
        low_sensitivity = UserProfile(
            triggers=["maple"],
            sensitivity="low",
            knowsTreeTriggers=True,
        )
        high_sensitivity = UserProfile(
            triggers=["maple"],
            sensitivity="high",
            knowsTreeTriggers=True,
        )

        low_score = score_routes([route], low_sensitivity, WEATHER, POLLEN, current_month=self.month)[0]["candidate"].exposureScore
        high_score = score_routes([route], high_sensitivity, WEATHER, POLLEN, current_month=self.month)[0]["candidate"].exposureScore

        self.assertGreater(high_score, low_score)

    def test_minimizes_overall_tree_contact_when_tree_triggers_are_unknown(self):
        route = build_route(
            "r1",
            [(40.752, -73.984), (40.776, -73.97)],
            20,
            2100,
        )
        profile = UserProfile(
            triggers=[],
            sensitivity="medium",
            knowsTreeTriggers=False,
        )

        general_score = score_routes([route], profile, WEATHER, POLLEN, current_month=self.month)[0]["candidate"].exposureScore
        self.assertGreater(general_score, 0)

    def test_raises_exposure_when_pollen_and_wind_conditions_intensify(self):
        route = build_route(
            "r1",
            [(40.752, -73.984), (40.776, -73.97)],
            20,
            2100,
        )
        profile = UserProfile(
            triggers=[],
            sensitivity="medium",
            knowsTreeTriggers=False,
        )

        calm_score = score_routes(
            [route],
            profile,
            WeatherSignal(description=WEATHER.description, windSpeedMph=4, humidity=68, temperatureF=56),
            PollenSignal(treeIndex=2, grassIndex=POLLEN.grassIndex, weedIndex=POLLEN.weedIndex, summary=POLLEN.summary),
            current_month=self.month,
        )[0]["candidate"].exposureScore
        intense_score = score_routes(
            [route],
            profile,
            WeatherSignal(description=WEATHER.description, windSpeedMph=18, humidity=32, temperatureF=74),
            PollenSignal(treeIndex=5, grassIndex=POLLEN.grassIndex, weedIndex=POLLEN.weedIndex, summary=POLLEN.summary),
            current_month=self.month,
        )[0]["candidate"].exposureScore

        self.assertGreater(intense_score, calm_score)

    def test_can_use_route_specific_signals_to_change_ranking(self):
        first_route = build_route(
            "calm-corridor",
            [(40.752, -73.984), (40.776, -73.97)],
            20,
            2100,
        )
        second_route = build_route(
            "windy-corridor",
            [(40.752, -73.984), (40.776, -73.97)],
            20,
            2100,
        )
        profile = UserProfile(
            triggers=[],
            sensitivity="medium",
            knowsTreeTriggers=False,
        )
        route_signals = [
            RouteSignals(
                weather=WeatherSignal(description="Calm", windSpeedMph=4, humidity=66, temperatureF=58),
                pollen=PollenSignal(treeIndex=2, grassIndex=1, weedIndex=1, summary="Lower tree pollen"),
            ),
            RouteSignals(
                weather=WeatherSignal(description="Windy", windSpeedMph=18, humidity=32, temperatureF=74),
                pollen=PollenSignal(treeIndex=5, grassIndex=1, weedIndex=1, summary="Higher tree pollen"),
            ),
        ]

        ranked = score_routes(
            [first_route, second_route],
            profile,
            WEATHER,
            POLLEN,
            current_month=self.month,
            route_signals=route_signals,
        )

        self.assertEqual(ranked[0]["candidate"].id, "calm-corridor")
        self.assertLess(
            ranked[0]["candidate"].exposureScore,
            ranked[1]["candidate"].exposureScore,
        )

    def test_includes_score_breakdown_on_scored_candidates(self):
        route = build_route(
            "r1",
            [(40.752, -73.984), (40.776, -73.97)],
            20,
            2100,
        )
        profile = UserProfile(
            triggers=["oak"],
            sensitivity="medium",
            knowsTreeTriggers=True,
        )

        candidate = score_routes([route], profile, WEATHER, POLLEN, current_month=self.month)[0]["candidate"]

        self.assertIsNotNone(candidate.scoreBreakdown)
        self.assertEqual(candidate.scoreBreakdown.finalScore, candidate.exposureScore)
        self.assertGreaterEqual(candidate.scoreBreakdown.dataCoverage, 0)
        self.assertLessEqual(candidate.scoreBreakdown.dataCoverage, 1)
        self.assertGreaterEqual(candidate.scoreBreakdown.highRiskMeters, 0)


class GeometryAndWeightingTests(unittest.TestCase):
    def test_samples_points_by_equal_distance(self):
        points = [
            LatLngLiteral(lat=40.0, lng=-73.0),
            LatLngLiteral(lat=40.0, lng=-72.99),
        ]

        sampled = sample_route_points(points, 3)

        self.assertEqual(len(sampled), 3)
        self.assertAlmostEqual(sampled[0].lng, -73.0, places=5)
        self.assertAlmostEqual(sampled[1].lng, -72.995, places=3)
        self.assertAlmostEqual(sampled[2].lng, -72.99, places=5)

    def test_merge_cells_weights_closer_cells_more_heavily(self):
        point = LatLngLiteral(lat=40.75, lng=-73.98)
        cells = [
            TreeGridCell(
                key="0:0",
                center=LatLngLiteral(lat=40.75, lng=-73.98),
                areaName="Near block",
                density=1.0,
                canopyScore=80,
                topSpecies=["oak"],
                speciesWeights={"oak": 1.0},
            ),
            TreeGridCell(
                key="0:1",
                center=LatLngLiteral(lat=40.75, lng=-73.97979),
                areaName="Far block",
                density=0.6,
                canopyScore=20,
                topSpecies=["maple"],
                speciesWeights={"maple": 1.0},
            ),
        ]

        merged = merge_cells(cells, point, 20)

        self.assertEqual(merged["area_name"], "Near block")
        self.assertGreater(merged["canopy_score"], 50)
        self.assertEqual(merged["top_species"][0], "oak")

    def test_percentile_value_interpolates_across_sorted_values(self):
        value = percentile_value([10, 20, 30, 40], 0.9)

        self.assertAlmostEqual(value, 37, places=1)

    def test_relative_time_penalty_is_zero_for_fastest_route(self):
        self.assertEqual(get_relative_time_penalty(15, 15), 0)
        self.assertGreater(get_relative_time_penalty(20, 15), 0)


if __name__ == "__main__":
    unittest.main()
