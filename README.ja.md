[English](README.md) | 日本語

# Atmosphere - 空シミュレーター

**時刻と気象を渡すと、その空を概ね再現できる** レンダラです。
WebGLのフラグメントシェーダ1枚、依存ライブラリなし・DOMにもフレームワークにも依存しません。
実際の動作は `examples/` のサンプルをご覧ください。

```ts
import { Atmosphere } from '@takustaqu/atmosphere';

const sky = new Atmosphere(canvas, {
  time: new Date(),
  location: { latitude: 35.68, longitude: 139.77 },
  weather: { cloudCover: 0.95, precipitation: 12, windSpeed: 18 },
});
```

これで、その日その時刻の東京の、雲量95%・時間雨量12mm・風速18m/s の空が描かれ続けます。
`sky.set({ ... })` で条件を変えると、数秒かけて滑らかにその気象へ遷移します。

元々とあるゲームの個人的な移植を行う中で、追加要素として作ったものとなります。
気象の物理シミュレーションではないため正確性はありませんが、プロシージャルに変化し
続ける空を手軽に使えるものとなっているかと思います。

## 描けるもの

- **時刻** — 空のグラデーション、太陽（輪郭のない白飛びグレア）、
  夕焼け・マジックアワーの藤色、夜の街明かり
- **夜空** — ボートルスケールの光害、解像した星の集まりとして描く天の川
  （バルジと暗黒帯つき）、ZHR で指定する流星群
- **月** — 地球照で影側が見える三日月。海の暗斑がうっすら乗り、
  円盤は背後の星を遮蔽します
- **十種雲形** — 巻雲・巻層雲・巻積雲・高層雲・高積雲・乱層雲・層雲・層積雲・積雲・積乱雲。
  視線レイと雲平面の交差によるパース投影で、高度ごとに遠近が付きます
- **積乱雲のかなとこ** — 圏界面に達した塔が水平に広がります
- **雲のライティング** — 太陽方向の擬似シェーディング、シルバーライニング、
  連続的な厚みによる青灰色の影、曇天時は拡散光でフラットになります
- **雲の形状進化** — ドメインワープ場自体が動き、雲がその場で湧いて崩れます
- **降水** — 雨（風で傾く）、雪（風に流されて舞う）、レンズに付く水滴（オフにできます — [レンズ](#レンズ)）
- **荒天** — 稲光、暴風による雲の乱流
- **視程** — 霞・靄・霧。薄いうちは地平線側だけを潰し、濃くなると全天を覆います
- **レンズフレア** — 光軸上のゴースト、色収差、アナモルフィック風のストリーク
- **カラーフィルター** — セピア・モノクローム・青の記憶ほか
- **写真的コントロール** — 線形光合成の上に載るトーンカーブと、
  CPL フィルタのエミュレーション

## 気象条件の設定

気象は**観測の単位そのまま**で受け取ります。
現実の気象条件と合わせたような指定をする場合、気象情報をそのまま渡しても面白いかもしれません。

| プロパティ | 単位 | 意味 |
|:---|:---|:---|
| `cloudCover` | 0..1 | 全天雲量（オクタ表記なら /8 して渡す）。0 で雲ひとつない空になります |
| `clouds` | — | 十種雲形ごとの量。指定すると `cloudCover` より優先されます |
| `precipitation` | mm/h | 降水強度 |
| `precipitationType` | `'rain'` \| `'snow'` | 降水の種別 |
| `windSpeed` | m/s | 地上風速 |
| `thunder` | 0..1 | 雷の活発さ |
| `visibility` | km | 視程 |
| `convection` | 0..1 | 対流の発達（＝`clouds.cumulonimbus` の省略記法） |

名前付きのプリセットも同じ観測値で定義してあるので、両者は地続きです。

| id | 名前 | 雲量 | 降水 | 風速 | 視程 | 雷 |
|:---|:---|--:|--:|--:|--:|--:|
| `clear` | 快晴 | 0 | — | 2 | 45 | — |
| `fair` | 晴れ | 0.22 | — | 3 | 35 | — |
| `summer` | 夏空 | 0.38 | — | 3 | 25 | — |
| `overcast` | 曇り | 0.82 | — | 5 | 15 | — |
| `fog` | 霧 | 0.75 | — | 1 | 0.6 | — |
| `rain` | 雨 | 0.95 | 8 | 7 | 8 | 0.08 |
| `thunderstorm` | 雷雨 | 0.97 | 25 | 12 | 5 | 1.0 |
| `snow` | 雪 | 0.90 | 3 (雪) | 3 | 4 | — |
| `typhoon` | 台風 | 1.0 | 40 | 30 | 6 | 0.5 |

```ts
sky.set({ weather: 'typhoon' });                       // プリセット
sky.set({ weather: { cloudCover: 0.4, windSpeed: 9 } });  // 観測値
```

## 雲を渡す — 十種雲形

雲量ひとつでは「どんな雲か」は決まりません。同じ雲量8割でも、ひつじ雲の空と
のっぺりした雨雲の空はまるで違います。空には複数の雲形が同時に見えるので、
「主役をひとつ選ぶ」のではなく、**雲形ごとの量 0..1 を重ねます**。

```ts
sky.set({ weather: { clouds: { cirrus: 0.5, cumulus: 0.3 } } });  // 巻雲の下に綿雲
sky.set({ weather: { clouds: ['altocumulus'] } });                // ひつじ雲だけの空
```

| id | 和名 | 通称 | 高度 | 形態 |
|:---|:---|:---|:---|:---|
| `cirrus` | 巻雲 | すじ雲 | 上層 | 繊維状 |
| `cirrostratus` | 巻層雲 | うす雲 | 上層 | 層状（太陽に暈が出る） |
| `cirrocumulus` | 巻積雲 | うろこ雲・いわし雲 | 上層 | 粒状（細かい） |
| `altostratus` | 高層雲 | おぼろ雲 | 中層 | 層状 |
| `altocumulus` | 高積雲 | ひつじ雲 | 中層 | 粒状（中） |
| `nimbostratus` | 乱層雲 | あま雲 | 中層 | 層状（濃灰色・雨） |
| `stratus` | 層雲 | きり雲 | 下層 | 層状（低く垂れこめる） |
| `stratocumulus` | 層積雲 | くもり雲 | 下層 | 粒状（大・ロール状） |
| `cumulus` | 積雲 | わた雲 | 下層 | 対流塊 |
| `cumulonimbus` | 積乱雲 | 入道雲 | 下層 | 対流塊（かなとこ付き） |

`clouds` を渡さないときは、雲量・降水・対流・視程から妥当な雲形構成が組み立てられます
（`defaultCloudMix`）。気象APIが返すのは雲量であって雲形ではないので、素通しの経路は
こちらが受けます。「雲が少なければ綿雲と巻雲、増えれば層積雲と高層雲、降れば乱層雲」
という、ごく普通の空の成り立ちをなぞっています。

## 時刻と場所

`time` は `0..24` の数値・`Date`・`"14:30"`・ISO文字列のいずれでも構いません。

`location`（緯度経度）を併せて渡すと、`Date` から**実際の太陽位置**（方位角・高度）を
NOAA の式で計算します。緯度が変われば南中高度が変わり、季節が変われば日の長さが変わります。

```ts
sky.set({ time: '2026-12-21T16:00Z', location: { latitude: 64.1, longitude: -21.9 } });
// レイキャビクの冬至の16時 → もう夜
```

`location` を渡さないときは「6時に東から昇り、12時に南中し、18時に西へ沈む、
どこでもない北半球の中緯度」で代替します（南中高度46°）。

### タイムゾーン

タイムゾーンのパラメータはありません。`location` もタイムゾーンではありません。
緯度経度が決めるのは空のどこに太陽があるかであって、渡した `time` がどの時計の
時刻なのかについては何も言いません。

`Date` は絶対時刻ですので、そこから求めた太陽位置はどの環境で動かしても正しくなります。
それ以外は**実行環境の**ローカルタイムゾーンで解釈されます。オフセットのない ISO 文字列
（`'2026-07-26T14:30'`）は観測地ではなく実行環境のローカル時刻として読まれますし、
時刻も実行環境の時計から取ります。

ですので、ロンドンのマシンから*東京の*14:30 を描くときはオフセットを明示してください。

```ts
sky.set({ time: '2026-07-26T14:30+09:00', location: { latitude: 35.68, longitude: 139.77 } });
```

`new Date()` については何も気にする必要はありません。今この瞬間はどこでも今この瞬間です。

## カラーフィルター

輝度に落としてから任意の色に染め直す、フィルム的なグレーディングです。
セピアはそのプリセットのひとつでしかありません。

| id | 名前 | 用途 |
|:---|:---|:---|
| `none` | なし | |
| `sepia` | セピア | 回想 |
| `mono` | モノクローム | 完全な無彩色 |
| `faded` | 褪色 | 彩度を少し残し、黒を持ち上げたローコントラスト |
| `cyanotype` | 青の記憶 | 青写真調の寒色モノトーン |
| `gold` | 黄昏 | 暖色に寄せた金色調 |
| `ash` | 灰 | わずかに青みのある灰 |

```ts
sky.set({ filter: 'cyanotype' });                     // 全掛け
sky.set({ filter: { id: 'sepia', amount: 0.6 } });    // 薄く
sky.set({ filter: { tint: [1.1, 0.9, 1.0], saturation: 0.2, lift: 0.05 } });  // 自前の色
```

フィルターの切り替えも色ごと補間されるので、セピア → 青の記憶が滑らかに繋がります。

## カメラ / スカイボックス

描画はすべて**カメラから伸ばした視線レイ**で行われます。空の色・雲・太陽・月・星は
「その方向に何が見えるか」として解かれていて、スクリーン空間に残っているのは
レンズ側の現象（水滴・フレア・ビネット）だけです。

```ts
sky.set({ camera: { yaw: Math.PI / 2 } });   // 東を向く。太陽の位置も雲の流れも追随する
```

`yaw` は方位角（北=0、東=π/2）、`pitch` は仰角、`fov` は垂直画角です。既定は
「南を向いて仰角26°・画角49°」＝地平線が画面下端のすぐ外に来る背景向けの構えになっています。

`fov` を90°にして6方向を描けばキューブマップになります。その6面ぶんのカメラは
`CUBE_FACE_CAMERAS` にあります。

```ts
import { AtmosphereRenderer, CUBE_FACE_CAMERAS, resolveConditions } from '@takustaqu/atmosphere';

const renderer = new AtmosphereRenderer(canvas);   // 正方形の canvas
const state = resolveConditions({ time: 16.5, weather: 'summer' });
renderer.resize(512, 512);
for (const face of CUBE_FACE_CAMERAS) {
  renderer.render(0, state, face);
  // gl.readPixels なり toDataURL なりで焼く
}
```

このループを1行で済ませるのが `renderCubeFaces` です。

```ts
import { renderCubeFaces } from '@takustaqu/atmosphere';

const faces = renderCubeFaces({ time: 16.5, weather: 'summer' }, { size: 512 });
```

`CUBE_FACE_CAMERAS` の順（+X 東・-X 西・+Y 天頂・-Y 天底・+Z 北・-Z 南）で、
正方形の2D canvas を6枚返します。そのまま `drawImage` や `toDataURL`、
キューブマップ面へのアップロードに使えます。呼び出しごとに使い捨ての WebGL
コンテキストを作って破棄するので、毎フレーム呼ぶものではなくシーン切替時の
ベイク用です（WebGL非対応の環境では throw します）。

## 夜空 — 光害・天の川・流れ星

`weather` と対になる軸です。`weather` が大気のふるまいなら、`celestial` はその
背後にあるもの。両者が独立なので軸を分けています — 流星群は気象条件ではないし、
同じ流星群でも曇れば何も見えません。

```ts
sky.set({ celestial: 'perseids' });
sky.set({ celestial: { bortle: 3 } });                  // 天の川はそこから導出される
sky.set({ celestial: { bortle: 2, meteors: 40 } });
```

単位は weather と同じ方針で、実際に観測に使われている単位そのままです。

| プロパティ | 単位 | 意味 |
|:---|:---|:---|
| `bortle` | 1..9 | **ボートル・スケール**（光害の尺度）。星の密度と地平線側の街明かりを駆動。既定 6 — これまで描いてきた明るい郊外の空 |
| `milkyWay` | 0..1 | 天の川の見え。省略時は `bortle` から導出。ボートル6では消えるので、既定の空に天の川が無かったのはそのため |
| `meteors` | /h | **ZHR**（天頂出現数）。散在流星は約5、ペルセウス座は約100、ふたご座は約150。既定 0。**ZHR は全天を数えた値**で画角が見ているのは全天の2割弱なので、正直な 150 では数分に1個しか写りません。見せたいなら千の桁を使ってください |
| `radiant` | `[仰角, 方位角]` | 流星群の放射点。`null` で散在流星 |

プリセット: `dark-sky` `rural` `suburban` `city` `perseids` `geminids`

**既定は完全な no-op** です。`celestial: 'suburban'` は省略時とピクセル単位で一致
するので、明示的に指定するまで既存の空は何も変わりません。

描き方について2点。

**天の川は星でできています。** 帯は発光する縞を塗るのではなく、その場所の星の密度を
上げます。拡散光は「分解できなかった残り」だけです。逆にすると等倍で見たときに
エアブラシで引いた斜線に見えます（実際そうなっていたので直しました）。線形空間の
加算光として入っているのも重要で、ほぼ真っ黒な空に薄い帯を足すのは、ガンマ空間の
合成が最も破綻するケースです。

**流れ星は物体ではなくイベントです。** 雷と同じ機構で動きます — 時計をスロットに
切り、ハッシュして、閾値を超えたら発火。レイ空間で描いているので、視点を振っても
流星は空の同じ場所に留まります（スクリーン空間だと画面に貼り付いて嘘になります）。

> `prefers-reduced-motion: reduce` では `Atmosphere` が静止画を1フレームだけ
> 描くので、そこでは `meteors` を 0 に落としています — 飛行中で凍った筋は空に
> 引っかき傷として残るだけなので。`AtmosphereRenderer` を自分で回す場合は
> 呼び出し側の判断になります。

## トーンカーブ

下のカラーフィルターと違い scene-referred です。表示値になる前の線形なシーン光に
作用します — そこでしか意味を持たないので。線形光での乗算は露出ですが、
ガンマエンコード済みの値への同じ乗算は妙な暗転にしかなりません。

```ts
sky.set({ tone: 'filmic' });
sky.set({ tone: { exposure: 0.4, contrast: 1.15 } });
```

| フィールド | 効果 |
|:---|:---|
| `exposure` | 段（stop）。0 で無変化、+1 で光量2倍 |
| `contrast` | 18% グレーを軸にしたコントラスト。1 で無変化 |
| `knee` | ハイライトのショルダーが始まる位置。**それ未満は恒等**なので、既定の 0.8 では白飛びだけを整形する |
| `bleach` | 0..1 ハイライトを白へ脱色。フィルムの挙動で、明るい空がクリップして濁るのを防ぐ |

プリセット: `neutral` `flat` `punch` `filmic` `blown`

肝は `knee` です。0.8 では既存の見た目に触りません。下げると中間調までカーブが
かかり、そこから先が「画作り」になります。同じショルダーが HDR のとき `headroom`
へ伸びるので、いま詰めたカーブが将来そのまま使えます。

## 円偏光フィルター（CPL）

グレーディングではなく光学フィルターのエミュレーションです。シーン光に対する
透過率の乗算なので、雲・太陽・月・星が合成される**前**の空のグラデーションに適用します。

```ts
sky.set({ polarizer: 'strong' });
sky.set({ polarizer: { strength: 0.6, angle: Math.PI / 4 } });
sky.set({ polarizer: true });    // light CPL の略記
```

準拠している物理: レイリー散乱の空の光は部分偏光していて、太陽から 90° で最も強く
なります（`sin²θ / (1 + cos²θ)`）。一方、雲の光は波長より遥かに大きい水滴による
ミー散乱でほぼ無偏光、直射日光も同じです。だからフィルターは空だけを暗くして雲は
そのまま残る — 写真家が持ち歩く理由そのものです。快晴の正午、太陽を背にした画角、
`strength: 0.9` での実測:

| | 無フィルター比の輝度 |
|:---|---:|
| 青空、`angle: 0` | **62%** |
| 青空、`angle: π/2` | **126%** |
| 曇天（全面雲） | **99.8%** |

雲が浮き上がるのは雲が明るくなったからではなく、背後の空が落ちたからです。
`angle` を回すと周期 180° で滑らかに両極を行き来し、偏光の向きが画面内で回転する
ため広い画角では暗さのムラが出ます — 実物に出る本物のアーティファクトです。

| フィールド | 効果 |
|:---|:---|
| `strength` | 0..1 偏光成分をどれだけ落とすか |
| `angle` | 回転角（ラジアン）。~0 で暗く、~π/2 で明るく |
| `saturation` | 0..1 残った光の彩度を上げる（白いベールが偏光成分と一緒に抜けるため） |
| `stopLoss` | 0..1 実機の約1.3段の減光をどれだけ再現するか。既定 0 — 露出補正なしで減光だけ再現すると単に暗くなるので |

プリセット: `none` `light` `strong` `crossed`

## レンズ

空ではなく、レンズの表面で起きること。今のところは雨の間にレンズへ付く水滴です —
粒になって付き、背後の空を屈折させ、やがて乾いて消えます。既定ではオンですが、
UI の背景に敷く空なら、雨は降らせたいが架空のカメラに付いた水は要らない、という
ことがよくあります。

```ts
sky.set({ lens: { droplets: false } });   // きれいなガラス越しの雨
sky.set({ lens: { droplets: 0.4 } });     // 控えめな水滴
sky.set({ lens: { droplets: true } });    // 既定に戻す
```

| フィールド | 効果 |
|:---|:---|
| `droplets` | 0..1（または真偽値）レンズの水滴の上限。水滴は雨に追従するので、晴れていればどの値でも付きません。既定 1 |

ほかのパラメータと同じく数秒かけて移り変わるので、オフにするとガラスの水滴は
一瞬で消えずに乾いていきます。0 のときは水滴の処理そのものを飛ばします（見えない
ように描いているのではありません）。

## 前景のためのライティング情報

空の手前には、たいてい何かが立ちます — アバター、商品、カード。それが空に
なじむのは、同じ光が当たっているときだけです。太陽がカメラの前方にあれば
背後から縁が光り（逆光のリムライト）、背景の色が輪郭に回り込み（ライトラップ）、
上からは空、下からは地面の光が回る。`sky.light` はそれを、別のレンダラが
ライティングに使える素の数値として渡します。

```ts
const sky = new Atmosphere(canvas, {
  lightProbe: true,                       // 空を毎秒10回ほど計測
  onLight: (light) => { /* 自分のレンダラへ流し込む */ },
});

const light = sky.light;                  // 描画のたびに読んでもよい
```

中身は出どころの違う二つに分かれます。

**光源** — `light.sun`、`light.moon`、`light.key`（場面をより照らしている方。
どちらも無ければ `null`）。シェーダーと同じ式で状態から計算するので、正確で、
コストはゼロで、毎フレームカメラに追従します。計測（probe）を切っていても使えます。

| フィールド | 内容 |
|:---|:---|
| `direction` | 光源への単位ベクトル。ワールド軸（x 東、y 上、z 北） |
| `view` | 同じ向きをカメラ座標で（x 右、y 上、z 画面の奥）。**`view[2] > 0` なら逆光** — 被写体の背後にある — で、`(view[0], view[1])` が画面上でリムが向く方向 |
| `screen` | `{ x, y, inFront }`。左上原点の 0..1、画面外なら範囲外の値 |
| `color` | リニア RGB、最大チャンネルを 1 に正規化 — 昼は白、夕方は橙 |
| `visibility` | 0..1 光がどれだけ届くか（地平線と雲量） |
| `intensity` | 太陽と月を同じ尺度にした `visibility`。快晴の太陽が 1（月は `MOON_RELATIVE` 止まり） |

**計測値** — `light.frame` と `light.environment`。実際のシェーダーを小さな
オフスクリーンに描いて読み戻すので、雲・霞・フィルター・トーンカーブが全部
反映されます。最初の計測まで、また `lightProbe` がオフの間は `null` です。

| フィールド | 内容 | 用途 |
|:---|:---|:---|
| `frame.average` | 画面全体 | 前景全体の露出・色かぶり |
| `frame.grid` | 画面を `cols × rows`（既定 8×6）に分けたセル、左上から | **ライトラップ**：被写体の輪郭付近で `sampleLightGrid(grid, x, y)` |
| `environment.sky` / `.ground` | 地平線より上 / 下の天球 | 半球ライトの2色 |
| `environment.zenith` / `.horizon` | 60°より上 / 0〜15° | トップライト / 低い横からの光 |
| `environment.directions` | `east west up down north south` | アンビエントキューブ：`sampleEnvironment(env, normal)` |

色はすべて `LightSample` で、`srgb`（0..1、CSS や 2D canvas 用）、`linear`
（ライティング計算用）、`luminance` を持ちます。平均はリニア光で、立体角で重み付け
して取ります。画面（frame）は表示どおりに — レンズ効果も含めて — 計測します。
ライトラップに要るのは被写体の背後に実際に見えているものだからです。一方
environment からはフレアとビネットを除きます。

たとえば three.js なら：

```ts
const hemi = new THREE.HemisphereLight();
const rim = new THREE.DirectionalLight();

const sky = new Atmosphere(canvas, {
  lightProbe: true,
  onLight: (light) => {
    if (light.environment) {
      hemi.color.setRGB(...light.environment.sky.linear);
      hemi.groundColor.setRGB(...light.environment.ground.linear);
    }
    const key = light.key ? light[light.key] : null;
    rim.intensity = key ? key.intensity * 3 : 0;
    if (key) {
      rim.color.setRGB(...key.color);
      rim.position.set(...key.direction);   // 同じ右手系・y 上の軸
    }
  },
});

// 二つのカメラの向きを揃える：yaw 0 が +z を向く
const d = threeCamera.getWorldDirection(new THREE.Vector3());
sky.set({ camera: { yaw: Math.atan2(d.x, d.z), pitch: Math.asin(d.y), fov: THREE.MathUtils.degToRad(threeCamera.fov) } });
```

気象コントローラーの **Foreground light** パネルは、この数値だけでライティング
した人物シルエット（フィル・ラップ・リム）を描きます（`examples/controller/figure.ts`）。
2D 合成の実装例としてそのまま参照できます。

**コスト。** 計測の描画は数千ピクセルなので無視できますが、GPU からの読み戻しは
そうではありません。`readPixels` は GPU を待つので、M2 Max でメインスレッドが
約 1ms 止まります。そのため `rate`（既定 毎秒10回）に間引き、フレーム本体の描画の
前に行って自分の分だけを待つようにし、結果は `smoothing` 秒（既定 0.3）かけて
なじませます — 動く空を数十点でサンプルするので、そのままだとちらつくためです。
`smoothing: 0` にすれば雷光もそのまま届きます。`sky.measureLight()` はその場で
1回、平滑化なしで計測します（probe オプションの有無に関係なく）。
`AtmosphereRenderer.probe()` は独自ループ向けの同じ機能です。

## Display P3

対応しているブラウザでは Display P3 で、そうでなければ sRGB で描きます。
`colorSpace` の既定は `'auto'` なので、設定は要りません。

```ts
const sky = new Atmosphere(canvas, { colorSpace: 'srgb' });   // 明示的に切る
sky.colorSpace;   // 実際に使われている空間（'display-p3' か 'srgb'）
```

変換は見た目を保ちます。パレットは一切動かず、どちらのディスプレイでも空は同じに
見えます。得られるものは狭いですが実在します — すでに 1.0 を超えていたハイライト
（太陽のコア、雷の閃光）は P3 のほうが遅く切り捨てられるので、白飛びがわずかに残ります。

現状、**sRGB の外には出ていません**。これは実装漏れではなくパレットの性質です。
sRGB と Display P3 は青の原色が同一なので、P3 の余地は赤と緑だけにあります。
一方で空は青が支配的です。唯一の暖色である magic hour の琥珀も、合成後は
彩度の低いサーモンで sRGB の内側に十分収まっています。2つの色空間を readback して
差分を取って測ったところ、光源を意図的に広げても sRGB の外へは 1.5% 未満しか出ず、
magic hour はそもそも一度も sRGB を出ませんでした。目に見える広ガマットの空にするには
約60個の色リテラルを P3 の原色に対して引き直す必要があります。そのための機構
（`renderer.ts` の `GAMUT_REACH`）は入れてありますが、未使用です。

広ガマットでベイクするときは受け側の 2D canvas も揃える必要があり、
揃えないとコピーの時点で sRGB に切り落とされます。`renderCubeFaces` は
面倒を見ますが、自分でループを書く場合は `renderer.colorSpace` を渡してください。

```ts
canvas.getContext('2d', { colorSpace: renderer.colorSpace }).drawImage(source, 0, 0);
```

## モーション低減

全画面の背景が動き続けるのは前庭障害のある方にはつらいので、既定で
`prefers-reduced-motion: reduce` を尊重します。reduce のとき `start()` は
ループせず静止画を1フレームだけ描き、`set()` はトランジション無しのカットで
反映されます。メディアクエリの変化にも追従するので、OSの設定を切り替えれば
その場でループが止まり、また動き出します。

```ts
const sky = new Atmosphere(canvas, { respectReducedMotion: false });  // 設定によらず動かし続ける
sky.reducedMotion;   // 静止させている間は true
```

## API

| export | 役割 |
|:---|:---|
| `Atmosphere` | canvas + レンダラ + 描画ループ。`set()` / `jump()` / `start()` / `stop()` / `dispose()` |
| `AtmosphereRenderer` | 1回の `render()` が1枚。自前のループやオフスクリーン描画向け |
| `StateAnimator` | 目標への追従と、風・形状進化の積分。DOM非依存 |
| `resolveConditions(c)` | `Conditions` → `AtmosphereState` |
| `resolveWeather(w)` | 観測値・プリセット → 0..1 のパラメータ |
| `resolveClouds(c)` / `defaultCloudMix(...)` | 雲形の解決と、雲量からの自動展開 |
| `CLOUD_GENERA` | 十種雲形のメタ情報（英名・通称・高度・形態） |
| `resolveFilter(f)` | フィルター指定の解決 |
| `solarPosition(date, loc)` | 緯度経度と日時から太陽の方位角・高度 |
| `WEATHER_PRESETS` / `FILTER_PRESETS` | プリセット |
| `DEFAULT_CAMERA` / `CUBE_FACE_CAMERAS` | カメラ |
| `renderCubeFaces(c, opts)` | スカイボックス6面を一発でベイクし、2D canvas で返す |
| `resolveCelestial(c)` | 夜空指定の解決 |
| `resolveTone(t)` / `resolvePolarizer(p)` | トーンカーブ・偏光フィルター指定の解決 |
| `resolveLens(l)` | レンズ指定の解決 |
| `celestialLights(s, cam, aspect)` | 太陽と月を平行光源として（計測なしで） |
| `sampleLightGrid(g, x, y)` / `sampleEnvironment(env, n)` | 計測値を画面上の点で / 面の法線方向で読む |
| `srgbToDisplayP3(c)` / `displayP3ToSrgb(c)` | エンコード済みの色を2つの空間の間で変換 |
| `formatTod(tod)` | `14.5` → `"14:30"` |
| `weatherLabel(id, locale)` / `filterLabel(id, locale)` / `cloudGenusLabel(id, locale)` | ラベルの多言語化（`'en'` / `'ja'`） |

`Atmosphere` を使わず、自前の描画ループに組み込む場合は次のようにします。

```ts
const renderer = new AtmosphereRenderer(canvas);   // WebGL非対応なら renderer.available === false
const anim = new StateAnimator(resolveConditions({ time: 14, weather: 'summer' }));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.2, (now - last) / 1000); last = now;
  anim.step(resolveConditions({ time: 23, weather: 'typhoon' }), dt);   // 目標を毎フレーム渡す
  renderer.render(now / 1000, anim.current, DEFAULT_CAMERA, anim.wind, anim.evolution);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## シェーダーのコンパイル待ち

シェーダーはメインスレッドを止めずにコンパイルされるので、ページが立ち上がった直後の
ひとときは何も描かれません。その間 `render()` は何もせず、済んだかどうかは `ready`、
済んだ瞬間は `onReady` でわかります。引数が `false` のときはその端末ではシェーダーを
コンパイルできなかったという意味なので、フォールバックの背景をそのまま出し続けてください。

```tsx
const [ready, setReady] = useState(false);
useEffect(() => {
  const sky = new Atmosphere(canvasRef.current!, { weather: 'summer', onReady: setReady });
  return () => sky.dispose();
}, []);
// <canvas style={{ opacity: ready ? 1 : 0, transition: 'opacity 600ms' }} />
```

待ち時間を決めるのはシーンの内容ではなくブラウザとドライバです。Windows の WebGL は
ANGLE の Direct3D バックエンド経由で動き、そのコンパイラはこの規模のシェーダーを
インライン展開・ループ展開して巨大な中間表現にするため、初回訪問だけ数秒かかります
（macOS ではほぼ一瞬）。2回目以降はどの環境でも即座です——ブラウザがコンパイル済み
シェーダーをディスクにキャッシュするためです。

リンクが終わるまでブロックさせたい場合は `AtmosphereRenderer` に `compile: 'sync'` を
渡します。`renderCubeFaces` はこちらを使っています（焼き込みには戻ってくるループが
ないため）。画面に出すものには使わないでください。

## 多言語対応

コア（`CLOUD_GENERA` / `WEATHER_PRESETS` / `FILTER_PRESETS`）の `label` / `alias` は英語です。
日本語ラベルは `weatherLabel(id, 'ja')` / `filterLabel(id, 'ja')` / `cloudGenusLabel(id, 'ja')`
（`src/i18n.ts`）から引けます。

```ts
import { weatherLabel, cloudGenusLabel } from '@takustaqu/atmosphere';

weatherLabel('typhoon', 'ja');           // '台風'
cloudGenusLabel('cumulonimbus', 'ja');   // { label: '積乱雲', alias: '入道雲' }
```

`examples/react/AtmosphereControls` は `locale` プロパティ（既定 `'en'`）でこれを切り替えます。

## サンプル

`examples/` はレンダラの使用例であって、atmosphere の一部ではありません。
気に入らなければコピーして書き換えるのが早いです。

### React

```tsx
import { AtmosphereCanvas } from '@takustaqu/atmosphere/react';
import '@takustaqu/atmosphere/react/styles.css';

<AtmosphereCanvas time={new Date()} weather="rain" filter="sepia" />
```

動作確認用の設定パネル `AtmosphereControls` も同梱しています。

### 気象コントローラー

```bash
pnpm playground   # → http://localhost:8791/examples/controller/
```

全パラメータを手で動かすサンプルです。**キャンバスをドラッグすると視点が回り、ホイールで画角が変わります。**
描画が視線レイ基準なので、これは平面の背景ではなく、その場に張られたスカイボックスを
内側から見回している状態そのものです。「6面を焼く」を押すと、同じ空がその場でキューブマップに落ちます。

観測値がレンダラ向けの 0..1 にどう解決されたかを常時表示するので、
`cloudCover` や `visibility` が何に効くのかを見ながら確かめられます。

### playground

```bash
pnpm playground   # → http://localhost:8791/examples/playground/
```

条件を並べたコンタクトシートです。`?sheet=time | weather | genus | sparse | tower | filter | location | camera`、
動くデモは `?sheet=grow`（積乱雲が湧いて、かなとこを張り、崩れるまでを40秒で繰り返します）、
実写と突き合わせるベンチマークは `?sheet=nimbostratus | altostratus | cumulonimbus`
で並べる軸を切り替えられます。見た目を変えたあとの回帰確認はこれを見るのが早いです。

## 設計メモ

- **太陽・カメラは方向で持ち、視線レイ基準で解く。** 太陽は方位角・高度で扱う。緯度経度からの
  実太陽位置がそのまま渡せ、カメラをどちらへ向けても破綻しない。空の色も仰角の関数として
  視線レイから求めるので、「画面の上端＝天頂」という前提が要らない。
- **風と形状進化は積分で進める。** 「経過時間 × 風速」で位置を出すと、天候変化で風速が変わった
  瞬間にオフセットが飛んで雲がワープする。毎フレーム `位置 += 風速 × dt` を積算すれば、風速が
  変わってもオフセットは連続。時刻を動かした分だけ雲も流れ、天候だけ変えたときは雲がその場で変質する。
- **荒天は雨・雪・風・雷に分解して持つ。** 独立させることで、無風の大雨も、雨の降らない暴風も
  描ける。空の暗さと雲の乱れはそこから導出する。
- **十種雲形は「4形態 × 3高度」に還元する。** 実際に違うのは繊維状・層状・粒状・対流塊の4形態と、
  高度（雲平面の投影スケール）だけ。
- **積乱雲の輪郭は2次元の場、1本の式で決める。** 方位ごとに高さを1つ決める1次元プロファイルでは
  三角形の山にしかならない。方位角と仰角の2次元場にし、「勢い − 高さ」の式でしきい値の内外を
  決めると、上ほど自然に細くなり頂上が丸くなる。方位方向の山を尖らせれば、高さを保ったまま
  上へすぼまる。
- **丸い房は球の和で作り、高周波を別に足す。** ノイズのしきい値切りは境界がどのスケールでも
  フラクタルになり、丸い房にはならない。ジッタした球の和なら境界は円弧になる。ただし球の和には
  高周波成分がないので、細部は別にノイズを重ねる。最低3段。薄く水平な派生形（かなとこ・ベール）は
  仰角の帯ではなく、塊を縦に潰した場として作る（帯は縁をどれだけほつれさせても構造として線にしかならない）。
- **陰影の信号は飽和させず、色のマッピング側でコントラストを作る。** ゲインを上げて `clamp(±1)`
  すると面の向きが2値になり、色も2色になる。信号は連続量のまま小さく保ち、白・中間・影の3点を
  広い `smoothstep` で渡り歩かせる。実写に寄せてコントラストを上げすぎると「押し当てた切り抜き」に
  見えるので、背景用途では迷ったら弱いほうを採る。
- **降水は「粒」ではなく「視界の喪失」として効かせる。** 粒だけ描くと「白い点が舞う晴れた空」に
  なる。粒の大きさ・間隔は奥行きに沿って連続的に散らさないと作り物に見える。量0の雲形は丸ごと
  スキップし、既定は軽量（30fps・解像度0.55倍）に保つ。
- **値ノイズの格子はテクスチャに焼き、明示LODで引く。** ここの雲はすべて `fbm` に行き着き、
  `fbm` はハッシュ20回に行き着く。それが数十箇所の呼び出し全部に展開される。実行は安いが
  コンパイルは破滅的で、Windows は ANGLE 経由で Direct3D にこれを渡し、全部インライン展開する。
  格子を小さなタイリングテクスチャから読み、補間をサンプラーのバイリニアに任せれば、
  同じ演算が1命令になる。ただし素朴に `texture2D` で引くと**遅くなる**——フラグメント
  シェーダーのフェッチは暗黙の微分を伴い、微分は非一様な制御フローの中に置けないので、
  コンパイラは分岐をフラット化して解決する。つまり「この雲形をスキップ」の分岐が
  スキップしなくなる。ミップレベルを明示すれば微分は要らず、分岐が戻ってくる。

## 積乱雲の派生形

かなとこ雲とベール雲は、十種雲形ではなく積乱雲に付随する形なので `features` で持ちます。
省略すると `cumulonimbus` の発達度から自動で決まります（ベール雲は伸び盛りに付き、
成熟してかなとこが張ると目立たなくなります）。

```ts
sky.set({ weather: {
  clouds: { cumulonimbus: 0.9 },
  features: { anvil: 1, velum: 0.3 },   // 明示指定
}});
```

この2つは見た目の作りが根本的に違います。かなとこ雲は**氷晶**なのでカリフラワーの粒立ちを
持たず、絹のような横筋になり、風下へ大きく張り出します。ベール雲は**水滴**なので繊維を持たず、
塔の中腹にのっぺり白い一枚として掛かります。

## 未実装

- 日付からの月相・月の軌道（いまは太陽の正反対・仰角35°に固定した三日月です）
- そのほかの変種・派生形（レンズ雲、穴あき雲、乳房雲、笠雲など）
- 大気散乱の物理モデル（レイリー/ミー散乱ではなく、色の手付けです）
- 気温・湿度・気圧そのものを反映する経路（いまは視程と雲量が受け皿になっています）

## 配布形態

npm パッケージは**ビルド済み ESM バンドル＋型定義**を公開しています
（`exports` が `dist/` を指します）。依存はなく、バンドラも必須ではありません。
参照用に TypeScript ソースも `src/` として同梱しています。リポジトリでは
`pnpm typecheck` で型検査、`pnpm build` で `dist/` を生成します。

リリース履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## ライセンス

MITライセンスです。
詳細は [LICENSE](LICENSE) を参照してください。
