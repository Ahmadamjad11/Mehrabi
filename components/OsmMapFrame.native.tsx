import { Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

type OsmMapFrameProps = {
  html: string;
};

export default function OsmMapFrame({ html }: OsmMapFrameProps) {
  return (
    <WebView
      source={{ html }}
      style={StyleSheet.absoluteFill}
      originWhitelist={["*"]}
      userAgent="MehrabiPrayerMap/1.0 (+https://mehrabi-dvz6x8x.manus.space)"
      javaScriptEnabled
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data) as { type?: string; url?: string };
          if (message.type !== "open-osm-link" || typeof message.url !== "string") return;
          if (!/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(message.url)) return;
          void Linking.openURL(message.url).catch(() => undefined);
        } catch {
          // Ignore messages that are not OSM source links.
        }
      }}
    />
  );
}
