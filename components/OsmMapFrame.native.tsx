import { StyleSheet } from "react-native";
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
      javaScriptEnabled
    />
  );
}
