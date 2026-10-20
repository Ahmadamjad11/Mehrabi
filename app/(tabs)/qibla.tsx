import { useLocalSearchParams } from "expo-router";
import { QiblaCompassScreen } from "@/components/qibla/QiblaCompassScreen";

export default function QiblaRoute() {
  const params = useLocalSearchParams<{ lang?: string }>();
  return <QiblaCompassScreen language={params.lang === "en" ? "en" : "ar"} />;
}
