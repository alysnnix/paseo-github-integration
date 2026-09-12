import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";

import { loadImage } from "../../shared/board";
import { isGitHubImageHost } from "../../shared/image-host";
import type { Styles } from "../theme/use-styles";
import { openExternalUrl } from "../web";

/**
 * One image on its own line of Markdown. A GitHub-hosted one goes through
 * `board.image` — a private repository's attachments answer 404 to the app,
 * which holds no token — and any other host is loaded by `Image` directly,
 * the way a browser would. Either way the size is measured first, so the
 * frame is right before the bitmap paints. A press opens the original.
 *
 * Failure falls back to the link the panel used to show, named after the
 * alt text, so nothing that was readable before is lost.
 */
export function RemoteImage({
  url,
  alt,
  styles,
  accentColor,
}: {
  url: string;
  alt: string;
  styles: Styles;
  accentColor: string;
}) {
  const fetchImage = useRpc(loadImage);
  /**
   * An image at a URL never changes underneath it, so once fetched and
   * measured it is cached for good (`staleTime: Infinity`) rather than on the
   * five-minute schedule everything else here uses; the query client's own
   * garbage collection is what eventually drops an entry nothing still holds
   * a reference to, replacing the fixed 24-entry cap this used to enforce by
   * hand.
   */
  const imageQuery = useQuery({
    queryKey: ["image", url],
    queryFn: () => {
      const source = isGitHubImageHost(url)
        ? fetchImage({ url }).then((result) => result.dataUrl)
        : Promise.resolve(url);
      return source.then(function measure(uri) {
        // The callback form: the promise form is newer than some react-native-web
        // builds the app has shipped on, and returns nothing there.
        return new Promise<{ uri: string; width: number; height: number }>((resolve, reject) => {
          Image.getSize(
            uri,
            (width, height) => resolve({ uri, width, height }),
            (cause: unknown) => reject(cause instanceof Error ? cause : new Error(String(cause))),
          );
        });
      });
    },
    staleTime: Infinity,
  });
  const image = imageQuery.data ?? null;
  const error =
    imageQuery.error == null
      ? null
      : imageQuery.error instanceof Error
        ? imageQuery.error.message
        : String(imageQuery.error);

  const label = alt.trim() === "" ? "image" : alt;

  if (error !== null) {
    return (
      <Text style={styles.mdParagraph}>
        <Text accessibilityRole="link" style={styles.mdLink} onPress={() => openExternalUrl(url)}>
          [image: {label}]
        </Text>
        <Text style={styles.imageCaption}> — {error}</Text>
      </Text>
    );
  }

  if (image === null) {
    return (
      <View style={[styles.imageFrame, styles.imagePending]}>
        <ActivityIndicator color={accentColor} />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${label}, opens on GitHub`}
      onPress={() => openExternalUrl(url)}
    >
      <View style={[styles.imageFrame, { aspectRatio: image.width / image.height }]}>
        <Image
          source={{ uri: image.uri }}
          style={styles.image}
          resizeMode="contain"
          accessibilityLabel={label}
        />
      </View>
      {alt.trim() === "" ? null : <Text style={styles.imageCaption}>{alt}</Text>}
    </Pressable>
  );
}
