import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";

import { BoardBody } from "./board-body";
import { BoardHeader } from "./board-header";
import { BoardFilterBar, BoardModeBar } from "./board-toolbar";
import { BoardDialogs } from "./board-dialogs";
import { SavedViews } from "../search/saved-views";
import { useStyles } from "../theme/use-styles";
import { useGitHubBoard } from "./use-github-board";

export function GitHubBoard(props: PluginSurfaceProps) {
  const styles = useStyles(props);
  const {
    board,
    busy,
    error,
    refresh,
    mode,
    selectColumnMode,
    showDiscussionsMode,
    visibleRelations,
    effectiveRelation,
    relationCounts,
    commitRelation,
    allOwners,
    ownerCounts,
    hiddenOwners,
    toggleOwner,
    selectAllOwners,
    selectNoOwners,
    repositories,
    hiddenRepos,
    toggleRepo,
    selectAllRepos,
    selectNoRepos,
    visibleSortOrders,
    effectiveSort,
    commitSort,
    searchQuery,
    setSearchQuery,
    promptValues,
    loginDraft,
    applyPrompts,
    applyLogin,
    watchedOwners,
    displayRows,
    renderRow,
    modeRows,
    bodyWidth,
    setBodyWidth,
    detailTarget,
    detailItem,
    detailProgress,
    closeDetails,
    savedFraction,
    commitWidth,
    openSendDialog,
    dropItem,
    labelTarget,
    setLabelTarget,
    applyItemLabels,
    sendTarget,
    setSendTarget,
    handleLaunched,
    rootRef,
    openFilter,
    setOpenFilter,
    showSettings,
    setShowSettings,
  } = useGitHubBoard(props, styles);

  return (
    <View ref={rootRef} style={styles.screen}>
      <BoardHeader
        surfaceProps={props}
        showBoardStatus={mode !== "saved-views"}
        styles={styles}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        board={board}
        busy={busy}
        refresh={refresh}
        setOpenFilter={setOpenFilter}
      />

      {showSettings ? null : (
        <BoardModeBar
          mode={mode}
          showDiscussionsMode={showDiscussionsMode}
          selectColumnMode={selectColumnMode}
          styles={styles}
        />
      )}

      {showSettings || mode === "projects" || mode === "saved-views" ? null : (
        <BoardFilterBar
          visibleRelations={visibleRelations}
          effectiveRelation={effectiveRelation}
          relationCounts={relationCounts}
          commitRelation={commitRelation}
          allOwners={allOwners}
          ownerCounts={ownerCounts}
          hiddenOwners={hiddenOwners}
          toggleOwner={toggleOwner}
          selectAllOwners={selectAllOwners}
          selectNoOwners={selectNoOwners}
          repositories={repositories}
          hiddenRepos={hiddenRepos}
          toggleRepo={toggleRepo}
          selectAllRepos={selectAllRepos}
          selectNoRepos={selectNoRepos}
          visibleSortOrders={visibleSortOrders}
          effectiveSort={effectiveSort}
          commitSort={commitSort}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          openFilter={openFilter}
          setOpenFilter={setOpenFilter}
          styles={styles}
        />
      )}

      {openFilter !== null ? (
        <Pressable
          accessibilityLabel="Close filter"
          style={styles.backdrop}
          onPress={() => setOpenFilter(null)}
        />
      ) : null}

      {error !== null && mode !== "saved-views" ? (
        <View style={styles.banner}>
          <Text style={styles.danger}>{error}</Text>
        </View>
      ) : null}

      {!showSettings && mode === "saved-views" ? (
        <SavedViews props={props} styles={styles} />
      ) : (
        <BoardBody
          surfaceProps={props}
          styles={styles}
          showSettings={showSettings}
          promptValues={promptValues}
          loginDraft={loginDraft}
          busy={busy}
          applyPrompts={applyPrompts}
          applyLogin={applyLogin}
          board={board}
          mode={mode}
          watchedOwners={watchedOwners}
          displayRows={displayRows}
          renderRow={renderRow}
          modeRows={modeRows}
          refresh={refresh}
          bodyWidth={bodyWidth}
          setBodyWidth={setBodyWidth}
          detailTarget={detailTarget}
          detailItem={detailItem}
          detailProgress={detailProgress}
          closeDetails={closeDetails}
          savedFraction={savedFraction}
          commitWidth={commitWidth}
          openSendDialog={openSendDialog}
          dropItem={dropItem}
        />
      )}

      <BoardDialogs
        props={props}
        styles={styles}
        overlays={{
          labelTarget,
          setLabelTarget,
          applyItemLabels,
          sendTarget,
          setSendTarget,
          handleLaunched,
        }}
      />
    </View>
  );
}
