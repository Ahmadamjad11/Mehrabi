import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { COLORS, styles } from "./mehrabiStyles";

type QiblaCompassProps = {
  language: "ar" | "en";
  compassHeading: number | null;
  qiblaRotation: number | null;
};

export default function QiblaCompass({ language, compassHeading, qiblaRotation }: QiblaCompassProps) {
  const keepDirectionTextUpright = `${compassHeading ?? 0}deg`;

  return (
    <View style={styles.qiblaCompass}>
      <View style={styles.qiblaTargetLabel}>
        <View style={styles.qiblaKaabaBadge}>
          <MaterialCommunityIcons name="cube-outline" size={23} color={COLORS.gold} />
        </View>
        <Text style={styles.qiblaKaabaLabel}>{language === "ar" ? "الكعبة" : "Kaaba"}</Text>
      </View>
      <View style={styles.qiblaTargetStem} />

      <View style={styles.qiblaRing}>
        {compassHeading !== null && (
          <View style={[styles.qiblaDial, { transform: [{ rotate: `${-compassHeading}deg` }] }]}>
            <View style={[styles.qiblaNorthMarker, { transform: [{ rotate: keepDirectionTextUpright }] }]}>
              <Text style={styles.qiblaDirectionNorth}>{language === "ar" ? "شمال" : "N"}</Text>
              <View style={styles.qiblaNorthDot} />
            </View>
            <Text style={[styles.qiblaDirectionEast, { transform: [{ rotate: keepDirectionTextUpright }] }]}>
              {language === "ar" ? "شرق" : "E"}
            </Text>
            <Text style={[styles.qiblaDirectionSouth, { transform: [{ rotate: keepDirectionTextUpright }] }]}>
              {language === "ar" ? "جنوب" : "S"}
            </Text>
            <Text style={[styles.qiblaDirectionWest, { transform: [{ rotate: keepDirectionTextUpright }] }]}>
              {language === "ar" ? "غرب" : "W"}
            </Text>
          </View>
        )}

        {qiblaRotation === null ? (
          <Ionicons name="compass-outline" size={36} color={COLORS.muted} />
        ) : (
          <View style={[styles.qiblaNeedleLayer, { transform: [{ rotate: `${qiblaRotation}deg` }] }]}>
            <View style={styles.qiblaNeedleTip} />
            <View style={styles.qiblaNeedleShaft} />
          </View>
        )}

        <View style={styles.qiblaCenter} />
        <View style={styles.qiblaAlignmentMarker} />
      </View>
    </View>
  );
}
