'use strict';

angular.module('polestar')
  .directive('datasetSelector', function(Drop, Dataset, Config, Spec, Logger) {
    return {
      templateUrl: 'components/datasetselector/datasetselector.html',
      restrict: 'E',
      replace: true,
      scope: {},
      link: function postLink(scope , element/*, attrs*/) {
        scope.Dataset = Dataset;

        // the dataset to add
        scope.addedDataset = {
          group: 'user'
        };

        scope.datasetChanged = function() {
          if (!Dataset.dataset) {
            Dataset.dataset = Dataset.currentDataset;
            funcsPopup.open();
            return;
          }

          Logger.logInteraction(Logger.actions.DATASET_CHANGE, Dataset.dataset.name);

          Dataset.update(Dataset.dataset).then(function() {
            Config.updateDataset(Dataset.dataset, Dataset.type);
            Spec.reset();
          });
        };

        scope.add = function(dataset) {
          Dataset.dataset = Dataset.add(angular.copy(dataset));
          scope.datasetChanged();

          scope.addedDataset.name = '';
          scope.addedDataset.url = '';
          funcsPopup.close();
        };

        var funcsPopup = new Drop({
          content: element.find('.popup-new-dataset')[0],
          target: element.find('.open-dataset-popup')[0],
          position: 'right top',
          openOn: 'click'
        });

        scope.$on('$destroy', function() {
          funcsPopup.destroy();
          funcsPopup = null;
        });
      }
    };
  });
